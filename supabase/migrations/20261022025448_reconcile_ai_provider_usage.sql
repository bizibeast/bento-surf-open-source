begin;

-- Existing usage remains intact. Each new AI attempt records its own maximum
-- reservation so a successful response can return only its unused portion.
create table public.provider_ai_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  provider text not null check (provider in ('workers-ai', 'openrouter', 'groq')),
  model text not null check (length(model) between 1 and 120),
  public_tool boolean not null default false,
  reserved_units bigint not null check (reserved_units > 0),
  settled_units bigint check (settled_units >= 0 and settled_units <= reserved_units),
  day_start date not null,
  month_start date not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index provider_ai_usage_reservations_created_idx on public.provider_ai_usage_reservations(created_at);
create index provider_ai_usage_reservations_workspace_idx on public.provider_ai_usage_reservations(workspace_id, created_at desc);
alter table public.provider_ai_usage_reservations enable row level security;
revoke all on public.provider_ai_usage_reservations from public, anon, authenticated, service_role;
grant select on public.provider_ai_usage_reservations to service_role;

-- An explicit, audited allowance can restore one affected workspace for one
-- calendar month. It never changes the global budget or automatically renews.
create table public.provider_budget_workspace_allowances (
  resource text not null references public.provider_budget_policies(resource)
    check (resource = 'ai_microusd'),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  period_start date not null check (period_start = date_trunc('month', period_start)::date),
  additional_units bigint not null check (additional_units between 0 and 5000000),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  primary key (resource, workspace_id, period_start)
);
alter table public.provider_budget_workspace_allowances enable row level security;
revoke all on public.provider_budget_workspace_allowances from public, anon, authenticated;
grant select, insert, update, delete on public.provider_budget_workspace_allowances to service_role;

create function public.reserve_ai_provider_usage(
  p_units bigint,
  p_workspace_id uuid,
  p_provider text,
  p_model text,
  p_public_tool boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
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
    or p_provider is null or p_provider not in ('workers-ai','openrouter','groq')
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

create function public.settle_ai_provider_usage(p_reservation_id uuid, p_actual_units bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  receipt public.provider_ai_usage_reservations%rowtype;
  resources text[];
  resource_name text;
  refund bigint;
  item record;
begin
  select * into receipt from public.provider_ai_usage_reservations where id = p_reservation_id for update;
  if not found or p_actual_units is null or p_actual_units < 0 or p_actual_units > receipt.reserved_units then
    return false;
  end if;
  if receipt.settled_units is not null then return receipt.settled_units = p_actual_units; end if;
  resources := case when receipt.public_tool then array['ai_microusd','public_ai_microusd'] else array['ai_microusd'] end;
  perform resource from public.provider_budget_policies
    where resource = any(resources) order by resource for update;
  refund := receipt.reserved_units - p_actual_units;
  if refund > 0 then
    foreach resource_name in array resources loop
      for item in select * from (values
        ('global','day',receipt.day_start),
        ('global','month',receipt.month_start),
        (receipt.workspace_id::text,'day',receipt.day_start),
        (receipt.workspace_id::text,'month',receipt.month_start)
      ) counters(scope,kind,start_date) where scope is not null loop
        update public.provider_budget_usage set units = units - refund
          where resource = resource_name and scope = item.scope
            and period_kind = item.kind and period_start = item.start_date and units >= refund;
        if not found then raise exception 'AI usage counter could not be reconciled'; end if;
      end loop;
    end loop;
  end if;
  update public.provider_ai_usage_reservations set settled_units = p_actual_units, settled_at = now()
    where id = receipt.id;
  return true;
end;
$$;

revoke all on function public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean) from public,anon,authenticated;
revoke all on function public.settle_ai_provider_usage(uuid,bigint) from public,anon,authenticated;
grant execute on function public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean) to service_role;
grant execute on function public.settle_ai_provider_usage(uuid,bigint) to service_role;

create or replace function public.cleanup_provider_cost_data()
returns void language plpgsql security definer set search_path=public as $$
begin
  delete from public.provider_ai_usage_reservations where id in
    (select id from public.provider_ai_usage_reservations where created_at < now()-interval '100 days' limit 5000);
  delete from public.provider_budget_workspace_allowances where (resource,workspace_id,period_start) in
    (select resource,workspace_id,period_start from public.provider_budget_workspace_allowances where period_start < current_date-100 limit 5000);
  delete from public.provider_budget_usage where ctid in
    (select ctid from public.provider_budget_usage where period_start<current_date-100 limit 5000);
  delete from public.social_mention_search_cache where ctid in
    (select ctid from public.social_mention_search_cache where expires_at<now()-interval '7 days' limit 1000);
  delete from public.social_preview_attempts where ctid in
    (select ctid from public.social_preview_attempts where created_at<now()-interval '30 days' limit 5000);
end;
$$;
revoke all on function public.cleanup_provider_cost_data() from public,anon,authenticated;
grant execute on function public.cleanup_provider_cost_data() to service_role;

commit;
