-- Disposable database only: fixtures come from scripts/test-provider-cost-db.py.
begin;
delete from public.managed_provider_spend_reservations;
delete from public.provider_ai_usage_reservations;
delete from public.provider_budget_usage where resource='ai_microusd';
update public.provider_budget_policies set enabled=true,daily_limit=10,monthly_limit=12,
  workspace_daily_limit=10,workspace_monthly_limit=12 where resource='ai_microusd';
update public.managed_provider_spend_policy set weekly_microusd=5,monthly_microusd=8;

do $$
declare
  workspace uuid := 'a2000000-0000-4000-8000-000000000001';
  actor uuid := 'a1000000-0000-4000-8000-000000000001';
  attempt uuid := gen_random_uuid();
  r jsonb;
  receipt uuid;
begin
  r := public.reserve_managed_provider_usage(workspace,actor,'managed-fixture',attempt,
    'ai_microusd',2,2,'heygen','heygen-voice-1');
  if r->>'allowed' <> 'true' then raise exception 'Managed HeyGen narration was rejected: %',r; end if;
  receipt := (r->>'reservation_id')::uuid;
  if not exists(select 1 from public.managed_provider_spend_reservations m
    join public.provider_ai_usage_reservations a on a.id=m.ai_reservation_id
    where m.id=receipt and m.provider='heygen' and a.provider='heygen' and a.reserved_units=2) then
    raise exception 'HeyGen did not reserve both managed and global allowances';
  end if;
  r := public.reserve_managed_provider_usage(workspace,actor,'managed-fixture',attempt,
    'ai_microusd',2,2,'heygen','heygen-voice-1');
  if r->>'allowed' = 'true' or (select count(*) from public.managed_provider_spend_reservations) <> 1 then
    raise exception 'Duplicate HeyGen attempt consumed another allowance';
  end if;
  r := public.reserve_managed_provider_usage(workspace,actor,'managed-fixture',gen_random_uuid(),
    'ai_microusd',3,3,'heygen','avatar_iv');
  if r->>'allowed' <> 'true' then raise exception 'HeyGen avatar boundary reservation failed'; end if;
  if not public.settle_managed_provider_usage(receipt,1) then raise exception 'HeyGen settlement failed'; end if;
  r := public.reserve_managed_provider_usage(workspace,actor,'managed-fixture',gen_random_uuid(),
    'ai_microusd',2,2,'heygen','avatar_iv');
  if r->>'allowed' <> 'false' or r->>'reason' <> 'managed_week' then
    raise exception 'HeyGen escaped the managed weekly cap: %',r;
  end if;
  update public.provider_budget_policies set daily_limit=4 where resource='ai_microusd';
  r := public.reserve_managed_provider_usage(workspace,actor,'managed-fixture',gen_random_uuid(),
    'ai_microusd',1,1,'heygen','avatar_iv');
  if r->>'allowed' <> 'false' or r->>'reason' <> 'global_day' then
    raise exception 'HeyGen escaped the shared global cap: %',r;
  end if;
  if (select count(*) from public.provider_ai_usage_reservations) <> 2 then
    raise exception 'Denied HeyGen attempt created a shared receipt';
  end if;
  r := public.reserve_ai_provider_usage(1,null,'unapproved-provider','model',false);
  if r->>'allowed' <> 'false' then raise exception 'Provider allowlist became open-ended'; end if;
  if has_function_privilege('anon','public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean)','execute')
    or has_function_privilege('authenticated','public.reserve_ai_provider_usage(bigint,uuid,text,text,boolean)','execute') then
    raise exception 'Untrusted role can reserve managed provider funds';
  end if;
end;
$$;
rollback;
