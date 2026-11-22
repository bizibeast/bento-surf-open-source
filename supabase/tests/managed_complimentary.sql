-- Disposable local database only. Never run fixtures against a hosted project.
begin;
do $$begin
  if to_regclass('private.managed_provider_complimentary_grants') is null then
    raise exception 'Explicit managed complimentary funding is not implemented';
  end if;
end $$;
delete from public.managed_provider_spend_reservations;
delete from public.provider_ai_usage_reservations;
delete from public.provider_budget_usage where resource='ai_microusd';
update public.provider_budget_policies set enabled=true,daily_limit=1000000,monthly_limit=1000000,
  workspace_daily_limit=1000000,workspace_monthly_limit=1000000 where resource='ai_microusd';
update public.managed_provider_spend_policy set weekly_microusd=5,monthly_microusd=8;
update public.profiles set plan_id='creator_plus',billing_catalog='2026-11-managed';
insert into public.complimentary_plan_grants(id,user_id,plan_id,status,expires_at)
select gen_random_uuid(),id,'creator_plus','active',now()+interval '30 days' from public.profiles;
insert into private.managed_provider_complimentary_grants
  (workspace_id,owner_id,complimentary_grant_id,product_id,expires_at,created_at,granted_by,reason)
select p.id,'a1000000-0000-4000-8000-000000000001',g.id,'managed-fixture',
  now()+interval '20 days',now()-interval '1 day','a1000000-0000-4000-8000-000000000001','Local test fixture'
from public.profiles p join public.complimentary_plan_grants g on g.user_id=p.id;

do $$declare r jsonb; begin
  r:=public.get_managed_provider_spend('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','managed-fixture');
  if r->>'billingPaymentId' <> 'paid-a' then raise exception 'Verified paid funding did not take precedence: %',r; end if;
end $$;
-- Remove LOCAL payment fixtures: complimentary access must work without them.
delete from public.subscriptions;
delete from public.payments;

do $$declare
  w uuid:='a2000000-0000-4000-8000-000000000001';
  actor uuid:='a1000000-0000-4000-8000-000000000001';
  r jsonb; receipt uuid; attempt uuid:=gen_random_uuid();
begin
  r:=public.get_managed_provider_spend(w,actor,'managed-fixture');
  if r->>'eligible' <> 'true' or r->>'billingPaymentId' not like 'complimentary:%' then
    raise exception 'Explicit funding grant did not enable managed access: %',r;
  end if;
  if (r#>>'{weekly,limitMicrousd}')::bigint<>5 or (r#>>'{monthly,limitMicrousd}')::bigint<>8 then
    raise exception 'Complimentary funding changed allowances';
  end if;
  if public.get_managed_provider_spend(w,actor,'wrong-product')->>'eligible'='true' then raise exception 'Wrong product allowed'; end if;
  if public.get_managed_provider_spend(w,'a1000000-0000-4000-8000-000000000002','managed-fixture')->>'eligible'='true' then raise exception 'Cross-tenant actor allowed'; end if;
  update private.managed_provider_complimentary_grants set revoked_at=now() where workspace_id=w;
  if public.get_managed_provider_spend(w,actor,'managed-fixture')->>'eligible'='true' then raise exception 'Revoked funding allowed'; end if;
  update private.managed_provider_complimentary_grants set revoked_at=null,expires_at=now()-interval '1 second' where workspace_id=w;
  if public.get_managed_provider_spend(w,actor,'managed-fixture')->>'eligible'='true' then raise exception 'Expired funding allowed'; end if;
  update private.managed_provider_complimentary_grants set expires_at=now()+interval '20 days' where workspace_id=w;
  update public.complimentary_plan_grants set plan_id='creator' where user_id=w;
  if public.get_managed_provider_spend(w,actor,'managed-fixture')->>'eligible'='true' then raise exception 'Creator received managed funding'; end if;
  update public.complimentary_plan_grants set plan_id='creator_plus',status='revoked' where user_id=w;
  if public.get_managed_provider_spend(w,actor,'managed-fixture')->>'eligible'='true' then raise exception 'Revoked plan grant allowed'; end if;
  update public.complimentary_plan_grants set status='active',expires_at=now()-interval '1 second' where user_id=w;
  if public.get_managed_provider_spend(w,actor,'managed-fixture')->>'eligible'='true' then raise exception 'Expired plan grant allowed'; end if;
  update public.complimentary_plan_grants set expires_at=now()+interval '30 days' where user_id=w;
  update public.profiles set billing_catalog='legacy' where id=w;
  if public.get_managed_provider_spend(w,actor,'managed-fixture')->>'eligible'='true' then raise exception 'Legacy workspace got managed resources'; end if;
  update public.profiles set billing_catalog='2026-11-managed' where id=w;
  r:=public.reserve_managed_provider_usage(w,actor,'managed-fixture',attempt,'ai_microusd',3,3,'openrouter','openai/gpt-6.1-sol');
  if r->>'allowed'<>'true' then raise exception 'Funded request rejected: %',r; end if;
  receipt:=(r->>'reservation_id')::uuid;
  r:=public.reserve_managed_provider_usage(w,actor,'managed-fixture',attempt,'ai_microusd',3,3,'openrouter','openai/gpt-6.1-sol');
  if r->>'allowed'='true' then raise exception 'Duplicate attempt allowed'; end if;
  if not public.settle_managed_provider_usage(receipt,1) then raise exception 'Funded request did not settle'; end if;
  r:=public.reserve_managed_provider_usage(w,actor,'managed-fixture',gen_random_uuid(),'ai_microusd',5,5,'heygen','avatar_iv');
  if r->>'allowed'<>'false' or r->>'reason'<>'managed_week' then raise exception 'Weekly cap escaped: %',r; end if;
  update public.managed_provider_spend_policy set weekly_microusd=10;
  r:=public.reserve_managed_provider_usage(w,actor,'managed-fixture',gen_random_uuid(),'ai_microusd',8,8,'openrouter','anthropic/claude-opus-5.5');
  if r->>'allowed'<>'false' or r->>'reason' not in ('managed_month','managed_billing_month') then raise exception 'Monthly cap escaped: %',r; end if;
  update public.provider_budget_policies set daily_limit=1 where resource='ai_microusd';
  r:=public.reserve_managed_provider_usage(w,actor,'managed-fixture',gen_random_uuid(),'ai_microusd',1,1,'openrouter','openai/gpt-6.2-sol');
  if r->>'allowed'<>'false' or r->>'reason'<>'global_day' then raise exception 'Global cap escaped: %',r; end if;
  if exists(select 1 from public.payments) or exists(select 1 from public.subscriptions) then raise exception 'Synthetic billing rows created'; end if;
  if has_table_privilege('anon','private.managed_provider_complimentary_grants','INSERT')
    or has_table_privilege('authenticated','private.managed_provider_complimentary_grants','INSERT')
    or has_table_privilege('service_role','private.managed_provider_complimentary_grants','INSERT') then raise exception 'Application roles can fund themselves'; end if;
end $$;
-- Leave a clean, funded fixture for parallel reservations in the Python harness.
delete from public.managed_provider_spend_reservations;
delete from public.provider_ai_usage_reservations;
delete from public.provider_budget_usage where resource='ai_microusd';
update public.provider_budget_policies set daily_limit=1000000 where resource='ai_microusd';
update public.managed_provider_spend_policy set weekly_microusd=5,monthly_microusd=8;
commit;
