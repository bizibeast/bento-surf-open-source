-- Run on a disposable local database with migrations applied. All fixtures roll back.
begin;
do $$
declare
  owner_a uuid := 'feedbaca-0000-4000-8000-000000000001';
  owner_b uuid := 'feedbaca-0000-4000-8000-000000000002';
  product text := 'managed-test-product';
  attempt_id uuid := 'feedbaca-0000-4000-8000-000000000003';
  response jsonb;
  receipt uuid;
begin
  insert into auth.users(id, email)
    values (owner_a, 'managed-one@bento.invalid'), (owner_b, 'managed-two@bento.invalid');
  update public.profiles set workspace_status = 'active' where id in (owner_a, owner_b);
  insert into public.subscriptions(user_id, plan_id, status, billing_catalog, dodo_subscription_id,
    product_id, billing_interval, current_period_end)
  values
    (owner_a, 'creator_plus', 'active', '2026-10', 'managed-test-a', product, 'Month', now() + interval '20 days'),
    (owner_b, 'creator_plus', 'trialing', '2026-11-managed', 'managed-test-b', product, 'Month', now() + interval '3 days');
  insert into public.payments(payment_id, subscription_id, status, total_amount, currency, occurred_at,
    settlement_amount, settlement_currency, dodo_charge_type, billing_contract_catalog)
  values ('managed-test-a', 'managed-test-a', 'succeeded', 9900, 'USD', now() - interval '1 day',
    9400, 'USD', 'renewal', '2026-11-managed');
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false'
    or public.get_managed_provider_spend(owner_b, owner_b, product)->>'eligible' <> 'false' then
    raise exception 'Legacy and trial contracts must have no managed funds';
  end if;
  update public.subscriptions set billing_catalog = '2026-11-managed' where user_id = owner_a;
  update public.subscriptions set status = 'active' where user_id = owner_b;
  if public.get_managed_provider_spend(owner_b, owner_b, product)->>'eligible' <> 'false'
    or public.get_managed_provider_spend(owner_a, owner_b, product)->>'eligible' <> 'false'
    or public.get_managed_provider_spend(owner_a, owner_a, 'different-product')->>'eligible' <> 'false' then
    raise exception 'The membership, payment and product gates must all be enforced';
  end if;
  response := public.get_managed_provider_spend(owner_a, owner_a, product);
  if response->>'eligible' <> 'true'
    or (response #>> '{weekly,limitMicrousd}')::bigint <> 7000000
    or (response #>> '{monthly,limitMicrousd}')::bigint <> 30000000 then
    raise exception 'Verified paid contract did not receive default spend: %', response;
  end if;

  update public.payments set settlement_amount = 100 where payment_id = 'managed-test-a';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'A one-dollar payment funded the default allowance';
  end if;
  update public.payments set settlement_amount = 9400, settlement_currency = 'EUR' where payment_id = 'managed-test-a';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'A non-USD settlement authorized managed usage';
  end if;
  update public.payments set currency = 'EUR', settlement_currency = 'USD' where payment_id = 'managed-test-a';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'true' then
    raise exception 'Adaptive USD settlement was not recognized';
  end if;
  update public.payments set tax = 50 where payment_id = 'managed-test-a';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'Unknown settlement tax funded the allowance';
  end if;
  update public.payments set settlement_tax = 50 where payment_id = 'managed-test-a';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'true' then
    raise exception 'Verified settlement tax was not recognized';
  end if;
  update public.payments set currency = 'USD', tax = null, settlement_tax = null, refund_status = 'partial'
    where payment_id = 'managed-test-a';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'Partial refund was ignored before its amount was known';
  end if;
  insert into public.refunds(refund_id, payment_id, status, amount, currency)
    values ('managed-partial-test', 'managed-test-a', 'succeeded', 3401, 'USD');
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'Payment below two-times spend after a refund was allowed';
  end if;
  update public.refunds set amount = 3400 where refund_id = 'managed-partial-test';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'true' then
    raise exception 'Payment exactly at two-times spend was denied';
  end if;
  delete from public.refunds where refund_id = 'managed-partial-test';
  update public.payments set refund_status = null where payment_id = 'managed-test-a';

  delete from public.provider_budget_usage where resource in ('ai_microusd', 'brave_search_requests');
  update public.managed_provider_spend_policy set weekly_microusd = 100, monthly_microusd = 150;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, attempt_id,
    'ai_microusd', 80, 80, 'openrouter', 'test-model');
  if response->>'allowed' <> 'true' then raise exception 'Initial reservation denied: %', response; end if;
  receipt := (response->>'reservation_id')::uuid;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, attempt_id,
    'ai_microusd', 80, 80, 'openrouter', 'test-model');
  if response->>'reason' <> 'duplicate_attempt' then raise exception 'Duplicate can re-execute: %', response; end if;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, gen_random_uuid(),
    'ai_microusd', 30, 30, 'openrouter', 'test-model');
  if response->>'reason' <> 'managed_week' or response->>'retry_at' is null then
    raise exception 'Weekly cap did not deny with reset: %', response;
  end if;
  if (select count(*) from public.provider_budget_usage where resource='ai_microusd' and units=80) <> 2 then
    raise exception 'Managed AI must use the existing global counters';
  end if;
  if not public.settle_managed_provider_usage(receipt, 40)
    or not public.settle_managed_provider_usage(receipt, 40)
    or public.settle_managed_provider_usage(receipt, 41)
    or public.settle_managed_provider_usage(receipt, 81) then
    raise exception 'Settlement should return only unused units exactly once';
  end if;
  response := public.get_managed_provider_spend(owner_a, null, product);
  if (response #>> '{weekly,remainingMicrousd}')::bigint <> 60
    or (response #>> '{monthly,remainingMicrousd}')::bigint <> 110
    or (select count(*) from public.provider_budget_usage where resource='ai_microusd' and units=40) <> 2 then
    raise exception 'Managed and global spend did not reconcile together: %', response;
  end if;

  update public.managed_provider_spend_policy set weekly_microusd=200, monthly_microusd=60;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, gen_random_uuid(),
    'ai_microusd', 21, 21, 'openrouter', 'test-model');
  if response->>'reason' not in ('managed_month', 'managed_billing_month') then
    raise exception 'Monthly cap failed: %', response;
  end if;
  update public.managed_provider_spend_reservations set created_at = now() - interval '35 days'
    where id = receipt;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, gen_random_uuid(),
    'ai_microusd', 21, 21, 'openrouter', 'test-model');
  if response->>'reason' <> 'managed_billing_month' then
    raise exception 'Calendar reset reused the same paid allowance: %', response;
  end if;

  update public.managed_provider_spend_policy set weekly_microusd=7000000, monthly_microusd=30000000;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, gen_random_uuid(),
    'brave_search_requests', 1, 4999, 'brave', 'web_search');
  if response->>'allowed' <> 'false' then raise exception 'Brave cost floor was bypassed'; end if;
  response := public.reserve_managed_provider_usage(owner_a, owner_a, product, gen_random_uuid(),
    'brave_search_requests', 1, 5000, 'brave', 'web_search');
  if response->>'allowed' <> 'true' then raise exception 'Brave reservation denied: %', response; end if;
  if (select count(*) from public.provider_budget_usage where resource='brave_search_requests' and units=1) <> 4 then
    raise exception 'Brave attempt did not count toward workspace and global quotas';
  end if;

  update public.bento_instance_settings set edition = 'self_hosted';
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'Self-hosted obtained managed credits';
  end if;
  update public.bento_instance_settings set edition = 'hosted';
  insert into public.refunds(refund_id, payment_id, status, amount, currency)
    values ('managed-refund-test', 'managed-test-a', 'succeeded', 9900, 'USD');
  if public.get_managed_provider_spend(owner_a, owner_a, product)->>'eligible' <> 'false' then
    raise exception 'Fully refunded period obtained managed credits';
  end if;
  update public.profiles set billing_lifecycle = jsonb_build_object('deleteAfter', now() + interval '1 day')
    where id = owner_b;
  response := public.reserve_workspace_checkout_for_product(owner_b, product);
  update public.workspace_recovery_checkouts set checkout_url = 'https://checkout.example/recovery'
    where id = (response->>'id')::uuid;
  if public.reserve_workspace_checkout_for_product(owner_b, product)->>'url' <> 'https://checkout.example/recovery' then
    raise exception 'Identical recovery product could not resume';
  end if;
  begin
    perform public.reserve_workspace_checkout_for_product(owner_b, 'legacy-checkout-product');
    raise exception 'Cross-product recovery was allowed';
  exception when raise_exception then
    if sqlerrm <> 'A different recovery checkout is still within its payment window.' then raise; end if;
  end;
  if has_function_privilege('authenticated','public.get_managed_provider_spend(uuid,uuid,text)','EXECUTE')
    or has_function_privilege('anon','public.reserve_managed_provider_usage(uuid,uuid,text,uuid,text,bigint,bigint,text,text)','EXECUTE')
    or has_table_privilege('authenticated','public.managed_provider_spend_reservations','SELECT')
    or has_table_privilege('authenticated','public.managed_provider_spend_policy','UPDATE') then
    raise exception 'Client access to managed accounting was exposed';
  end if;
end;
$$;
rollback;
