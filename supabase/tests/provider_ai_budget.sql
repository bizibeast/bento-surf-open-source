-- Contract test for an isolated test database. All fixtures and counters roll back.
begin;
insert into public.profiles(id, username) values
  ('10000000-0000-4000-8000-000000000091','ai_budget_test_a'),
  ('10000000-0000-4000-8000-000000000092','ai_budget_test_b') on conflict do nothing;
delete from public.provider_ai_usage_reservations;
delete from public.provider_budget_workspace_allowances;
delete from public.provider_budget_usage where resource in ('ai_microusd','public_ai_microusd');
update public.provider_budget_policies set enabled=true,daily_limit=1000,monthly_limit=5000,
  workspace_daily_limit=400,workspace_monthly_limit=1000 where resource='ai_microusd';
update public.provider_budget_policies set enabled=true,daily_limit=200,monthly_limit=500,
  workspace_daily_limit=200,workspace_monthly_limit=500 where resource='public_ai_microusd';

do $$
declare
  a uuid := '10000000-0000-4000-8000-000000000091';
  b uuid := '10000000-0000-4000-8000-000000000092';
  today date := (now() at time zone 'utc')::date;
  month_start date := date_trunc('month', now() at time zone 'utc')::date;
  r jsonb;
  receipt uuid;
  prior_receipt uuid;
  current_units bigint;
  old_day date;
  old_month date;
begin
  r := public.reserve_ai_provider_usage(120,a,'workers-ai','@cf/openai/gpt-oss-20b',false);
  if r->>'allowed' <> 'true' then raise exception 'Initial reservation denied'; end if;
  receipt := (r->>'reservation_id')::uuid;
  if (select count(*) from public.provider_budget_usage where resource='ai_microusd' and units=120) <> 4 then
    raise exception 'Reservation did not debit all four counters';
  end if;
  if not public.settle_ai_provider_usage(receipt,45) then raise exception 'Settlement failed'; end if;
  if (select count(*) from public.provider_budget_usage where resource='ai_microusd' and units=45) <> 4 then
    raise exception 'Unused reservation was not returned';
  end if;
  if not public.settle_ai_provider_usage(receipt,45) or public.settle_ai_provider_usage(receipt,44) then
    raise exception 'Settlement is not idempotent';
  end if;
  if public.settle_ai_provider_usage(receipt,-1) or public.settle_ai_provider_usage(receipt,121) then
    raise exception 'Invalid settlement accepted';
  end if;
  r := public.reserve_ai_provider_usage(50,b,'groq','openai/gpt-oss-20b',false);
  if r->>'allowed' <> 'true' then raise exception 'Other workspace reservation failed'; end if;
  if (select units from public.provider_budget_usage where resource='ai_microusd' and scope=a::text and period_kind='day' and period_start=today) <> 45 then
    raise exception 'Settlement crossed workspaces';
  end if;
  r := public.reserve_ai_provider_usage(400,a,'workers-ai','@cf/openai/gpt-oss-20b',false);
  if r->>'allowed' <> 'false' or r->>'reason' <> 'workspace_day'
    or (r->>'retry_at')::timestamptz <> ((today+1)::timestamp at time zone 'utc') then
    raise exception 'Denied reservation omitted its reset';
  end if;

  update public.provider_budget_policies set daily_limit=95 where resource='ai_microusd';
  r := public.reserve_ai_provider_usage(10,a,'workers-ai','@cf/openai/gpt-oss-20b',true);
  if r->>'allowed' <> 'false' then raise exception 'Exhausted global pool allowed'; end if;
  if exists(select 1 from public.provider_budget_usage where resource='public_ai_microusd') then
    raise exception 'Public budget was consumed before the overall budget denied';
  end if;
  if (select count(*) from public.provider_ai_usage_reservations) <> 2 then
    raise exception 'Denied attempt created a receipt';
  end if;
  update public.provider_budget_policies set daily_limit=1000 where resource='ai_microusd';
  r := public.reserve_ai_provider_usage(100,a,'workers-ai','@cf/openai/gpt-oss-20b',true);
  if r->>'allowed' <> 'true' then raise exception 'Public reservation failed'; end if;
  if not public.settle_ai_provider_usage((r->>'reservation_id')::uuid,40) then
    raise exception 'Public settlement failed';
  end if;
  if (select units from public.provider_budget_usage where resource='public_ai_microusd' and scope='global' and period_kind='day' and period_start=today) <> 40
    or (select units from public.provider_budget_usage where resource='ai_microusd' and scope='global' and period_kind='day' and period_start=today) <> 135 then
    raise exception 'Public settlement did not reconcile both resources';
  end if;

  -- Settlement uses the reservation's period, including a month boundary.
  old_day := month_start-1;
  old_month := date_trunc('month',old_day)::date;
  select units into current_units from public.provider_budget_usage where resource='ai_microusd' and scope='global' and period_kind='day' and period_start=today;
  insert into public.provider_ai_usage_reservations(workspace_id,provider,model,reserved_units,day_start,month_start)
    values(a,'workers-ai','@cf/openai/gpt-oss-20b',99,old_day,old_month) returning id into prior_receipt;
  insert into public.provider_budget_usage(resource,scope,period_kind,period_start,units) values
    ('ai_microusd','global','day',old_day,99),('ai_microusd','global','month',old_month,99),
    ('ai_microusd',a::text,'day',old_day,99),('ai_microusd',a::text,'month',old_month,99);
  if not public.settle_ai_provider_usage(prior_receipt,33) then raise exception 'Prior-period settlement failed'; end if;
  if (select units from public.provider_budget_usage where resource='ai_microusd' and scope='global' and period_kind='day' and period_start=today) <> current_units then
    raise exception 'Prior settlement changed the current day';
  end if;

  update public.provider_budget_usage set units=1000 where resource='ai_microusd' and scope in(a::text,b::text) and period_kind='month' and period_start=month_start;
  r := public.reserve_ai_provider_usage(10,a,'workers-ai','@cf/openai/gpt-oss-20b',false);
  if r->>'reason' <> 'workspace_month' then raise exception 'Monthly exhaustion was not reported'; end if;
  insert into public.provider_budget_workspace_allowances(resource,workspace_id,period_start,additional_units,reason) values
    ('ai_microusd',a,month_start,200,'One-time test recovery'),
    ('ai_microusd',b,(month_start+interval '1 month')::date,200,'Future allowance');
  r := public.reserve_ai_provider_usage(10,a,'workers-ai','@cf/openai/gpt-oss-20b',false);
  if r->>'allowed' <> 'true' then raise exception 'Scoped recovery allowance was not used'; end if;
  r := public.reserve_ai_provider_usage(10,b,'workers-ai','@cf/openai/gpt-oss-20b',false);
  if r->>'reason' <> 'workspace_month' then raise exception 'Allowance crossed a workspace or month'; end if;
  update public.provider_budget_policies set monthly_limit=(select units from public.provider_budget_usage where resource='ai_microusd' and scope='global' and period_kind='month' and period_start=month_start) where resource='ai_microusd';
  r := public.reserve_ai_provider_usage(10,a,'workers-ai','@cf/openai/gpt-oss-20b',false);
  if r->>'reason' <> 'global_month' then raise exception 'Recovery bypassed global cap'; end if;

  if has_function_privilege('anon','public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean)','EXECUTE')
    or has_function_privilege('authenticated','public.settle_ai_provider_usage(uuid,bigint)','EXECUTE')
    or has_table_privilege('authenticated','public.provider_ai_usage_reservations','SELECT')
    or has_table_privilege('authenticated','public.provider_budget_workspace_allowances','INSERT') then
    raise exception 'Client access to accounting or allowances was exposed';
  end if;
  if not has_function_privilege('service_role','public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean)','EXECUTE') then
    raise exception 'Service reservation permission missing';
  end if;
  perform public.cleanup_provider_cost_data();
end;
$$;
rollback;
