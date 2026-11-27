-- Run with psql -v ON_ERROR_STOP=1 after migrations. No fixture data survives.
begin;

do $$
declare
  owner_id uuid := gen_random_uuid();
  offer_id uuid;
  order_id uuid;
  grant_id uuid;
  provider_name text;
  subscription_id text;
  result jsonb;
  access_row public.commerce_subscription_access%rowtype;
  paid_end timestamptz := now() - interval '1 day';
  grace_end timestamptz := paid_end + interval '3 days';
  next_paid_end timestamptz := now() + interval '1 month';
begin
  insert into auth.users(id, email) values(owner_id, 'grace-test-' || owner_id || '@example.test');
  insert into public.commerce_products(creator_id, kind, status, slug, public_slug, title,
    pricing_type, price_amount, currency, billing_interval)
  values(owner_id, 'membership', 'published', 'grace-' || gen_random_uuid(), 'grace-' || gen_random_uuid(),
    'Grace membership', 'subscription', 1000, 'usd', 'month') returning id into offer_id;

  foreach provider_name in array array['stripe', 'polar', 'dodo', 'creem', 'paypal', 'razorpay'] loop
    subscription_id := provider_name || '-grace-sub';
    insert into public.commerce_orders(product_id, creator_id, buyer_email, status,
      provider, provider_account_id, provider_payment_id, provider_subscription_id,
      gross_amount, net_amount, currency, paid_at)
    values(offer_id, owner_id, 'buyer@example.test', 'paid', provider_name, 'grace-account',
      provider_name || '-grace-payment', subscription_id, 1000, 1000, 'usd', now() - interval '1 month')
    returning id into order_id;
    insert into public.commerce_access_grants(order_id, product_id, creator_id, buyer_email, token_hash)
    values(order_id, offer_id, owner_id, 'buyer@example.test', provider_name || '-grace-token')
    returning id into grant_id;

    perform public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'initial-paid', paid_end - interval '1 month', paid_end);

    -- Failure payload contains the *unpaid* next period. Never advance entitlement.
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'failure-1', paid_end, next_paid_end);
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.current_period_end <> paid_end or access_row.grace_expires_at <> grace_end
      or (result->>'access_deadline')::timestamptz <> grace_end then
      raise exception '%: failed billing advanced the paid period or grace', provider_name;
    end if;

    -- Distinct retry IDs and larger grace arguments cannot reset the deadline.
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'failure-2', paid_end, now() + interval '1 year', false, '{}', 30);
    if (result->>'access_deadline')::timestamptz <> grace_end then
      raise exception '%: repeated failure reset grace', provider_name;
    end if;
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'failure-2', now(), next_paid_end);
    if result->>'reason' <> 'already_processed' then raise exception 'Duplicate event was applied'; end if;

    perform public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'next-paid', now(), next_paid_end);
    -- Delayed renewal data cannot shorten a later paid period.
    perform public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'stale-paid', paid_end - interval '1 month', paid_end);
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'revoked', 'stale-terminal', null, paid_end);
    if result->>'reason' <> 'stale_terminal_event' then raise exception 'Stale terminal event applied'; end if;
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.current_period_end <> next_paid_end then raise exception 'Newer paid period shortened'; end if;

    -- Active status updates are not another payment and cannot advance the end.
    perform public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'active', 'generic-update', now(), next_paid_end + interval '1 month');
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.current_period_end <> next_paid_end then raise exception 'Status update advanced period'; end if;

    perform public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'revoked', 'terminal', null, next_paid_end);
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'late-failure', null, next_paid_end + interval '1 year');
    if result->>'reason' <> 'terminal_access_requires_payment' then raise exception 'Failure reactivated grant'; end if;
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'active', 'late-activation', null, next_paid_end + interval '1 year');
    if result->>'reason' <> 'terminal_access_requires_payment' then raise exception 'Status update reactivated grant'; end if;
    if (select status from public.commerce_access_grants where id = grant_id) <> 'revoked' then
      raise exception 'Terminal grant reactivated';
    end if;
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'paid-after-terminal', now(), next_paid_end + interval '1 month');
    if not (result->>'applied')::boolean
      or (select status from public.commerce_access_grants where id = grant_id) <> 'active' then
      raise exception 'New paid renewal did not recover access';
    end if;

    -- A final verified paid invoice advances the boundary before a completed
    -- snapshot schedules cancellation. The final purchased cycle remains usable.
    perform public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'cancel_at_period_end', 'final-paid-completed-snapshot',
      next_paid_end, next_paid_end + interval '1 month', true);
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.status <> 'cancel_at_period_end'
      or access_row.current_period_end <> next_paid_end + interval '1 month'
      or access_row.grace_expires_at is not null
      or (select expires_at from public.commerce_access_grants where id = grant_id)
        <> next_paid_end + interval '1 month' then
      raise exception 'Completed subscription lost its final verified paid cycle';
    end if;

    -- The former refunded-order fallback must use the same bounded-grace logic.
    update public.commerce_orders set status = 'partially_refunded' where id = order_id;
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'partial-refund-failure', null, now() + interval '10 years');
    if (result->>'access_deadline')::timestamptz <> next_paid_end + interval '1 month 3 days' then
      raise exception 'Recognized financial-order fallback extended grace';
    end if;
    update public.commerce_orders set status = 'refunded' where id = order_id;
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'active', 'after-full-refund', null, now() + interval '10 years');
    if result->>'reason' <> 'financial_access_revoked' then raise exception 'Refunded payment restored access'; end if;

    -- A first failure with no stored paid period uses the old actual payment,
    -- never today's time or the failing provider's future billing period.
    delete from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    update public.commerce_orders set status = 'paid' where id = order_id;
    update public.commerce_access_grants set status = 'active', expires_at = null where id = grant_id;
    result := public.apply_commerce_subscription_lifecycle_guarded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'first-observed-failure', now(), now() + interval '1 year');
    if result->>'status' <> 'expired'
      or (result->>'access_deadline')::timestamptz <> now() - interval '1 month' + interval '3 days'
      or (select status from public.commerce_access_grants where id = grant_id) <> 'expired' then
      raise exception 'First observed failure granted a fresh grace period';
    end if;
  end loop;
end;
$$;

-- Both entry points remain callable only by service_role.
do $$
begin
  if has_function_privilege('authenticated',
    'public.apply_commerce_subscription_lifecycle(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer)', 'execute')
    or has_function_privilege('anon',
    'public.apply_commerce_subscription_lifecycle_guarded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer)', 'execute') then
    raise exception 'Lifecycle RPC exposed to client roles';
  end if;
end;
$$;
rollback;
