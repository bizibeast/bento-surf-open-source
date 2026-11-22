-- Permit managed HeyGen receipts in the existing shared dollar meter.
-- No policy limits or existing reservations change.
begin;
alter table public.provider_ai_usage_reservations
  drop constraint provider_ai_usage_reservations_provider_check;
alter table public.provider_ai_usage_reservations
  add constraint provider_ai_usage_reservations_provider_check
  check (provider in ('workers-ai','openrouter','groq','heygen'));

create or replace function public.reserve_ai_provider_usage(
  p_units bigint,
  p_workspace_id uuid,
  p_provider text,
  p_model text,
  p_public_tool boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  policy public.provider_budget_policies%rowtype;
  resources text[] := case when p_public_tool then array['ai_microusd','public_ai_microusd'] else array['ai_microusd'] end;
  resource_name text;
  day_start date := (now() at time zone 'utc')::date;
  month_start date := date_trunc('month', now() at time zone 'utc')::date;
  owner_scope text := p_workspace_id::text;
  used_units bigint;
  extra_units bigint;
  item record;
  blocked_reason text;
  retry_at timestamptz;
  candidate_retry timestamptz;
  reservation_id uuid;
begin
  if p_units is null or p_units <= 0 or p_units > 1000000
    or p_provider is null or p_provider not in ('workers-ai','openrouter','groq','heygen')
    or p_model is null or length(p_model) not between 1 and 120
    or p_public_tool is null then
    return jsonb_build_object('allowed', false, 'reason', 'unavailable');
  end if;
  -- Same policy locks as reserve_provider_usage, always in stable order. Check
  -- both public and overall pools before debiting either one.
  perform resource from public.provider_budget_policies
    where resource = any(resources) order by resource for update;
  foreach resource_name in array resources loop
    select * into policy from public.provider_budget_policies where resource = resource_name;
    if not found or not policy.enabled then
      return jsonb_build_object('allowed', false, 'reason', 'unavailable');
    end if;
    select coalesce(sum(additional_units), 0) into extra_units
      from public.provider_budget_workspace_allowances
      where resource = resource_name and workspace_id = p_workspace_id and period_start = month_start;
    for item in select * from (values
      ('global','day',day_start,policy.daily_limit),
      ('global','month',month_start,policy.monthly_limit),
      (owner_scope,'day',day_start,policy.workspace_daily_limit),
      (owner_scope,'month',month_start,policy.workspace_monthly_limit + extra_units)
    ) limits(scope,kind,start_date,cap) where scope is not null loop
      if p_units > item.cap then
        return jsonb_build_object('allowed', false, 'reason', 'request_exceeds_limit');
      end if;
      select units into used_units from public.provider_budget_usage
        where resource = resource_name and scope = item.scope
          and period_kind = item.kind and period_start = item.start_date;
      if p_units > item.cap - coalesce(used_units, 0) then
        candidate_retry := (case when item.kind = 'month' then month_start + interval '1 month'
          else day_start + interval '1 day' end) at time zone 'utc';
        if retry_at is null or candidate_retry >= retry_at then
          retry_at := candidate_retry;
          blocked_reason := (case when item.scope = 'global' then 'global_' else 'workspace_' end) || item.kind;
        end if;
      end if;
    end loop;
  end loop;
  if blocked_reason is not null then
    return jsonb_build_object('allowed', false, 'reason', blocked_reason, 'retry_at', retry_at);
  end if;
  foreach resource_name in array resources loop
    insert into public.provider_budget_usage(resource,scope,period_kind,period_start,units)
    select * from (values
      (resource_name,'global','day',day_start,p_units),
      (resource_name,'global','month',month_start,p_units),
      (resource_name,owner_scope,'day',day_start,p_units),
      (resource_name,owner_scope,'month',month_start,p_units)
    ) reservations(resource,scope,period_kind,period_start,units) where scope is not null
    on conflict(resource,scope,period_kind,period_start)
      do update set units = provider_budget_usage.units + excluded.units;
  end loop;
  insert into public.provider_ai_usage_reservations(workspace_id,provider,model,public_tool,reserved_units,day_start,month_start)
    values (p_workspace_id,p_provider,p_model,p_public_tool,p_units,day_start,month_start)
    returning id into reservation_id;
  return jsonb_build_object('allowed', true, 'reservation_id', reservation_id);
end;
$$;

revoke all on function public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean) to service_role;
commit;
