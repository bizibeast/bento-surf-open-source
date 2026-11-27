-- Run with psql -v ON_ERROR_STOP=1 after migrations. No fixture data survives.
begin;

create function pg_temp.grace_paid_order(p_session uuid,p_payment text,p_subscription text)
returns uuid language plpgsql as $$
declare s public.commerce_payment_sessions%rowtype; r jsonb;
begin
 select * into strict s from public.commerce_payment_sessions where id=p_session;
 r:=public.fulfill_provider_commerce_order(s.product_id,s.buyer_email,'Buyer',s.provider,'grace-account',s.provider_checkout_id,p_payment,p_subscription,
  1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',s.id::text),s.access_token_hash);
 return (r->>'order_id')::uuid;
end;
$$;

do $$
declare
  owner_id uuid := gen_random_uuid();
  offer_id uuid;
  order_id uuid;
  initial_order_id uuid;
  account_id uuid;
  session_id uuid;
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
    insert into public.creator_payment_accounts(creator_id,provider,provider_account_id)
    values(owner_id,provider_name,'grace-account') returning id into account_id;
    insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
    values(offer_id,owner_id,account_id,provider_name,subscription_id,'buyer@example.test',1000,0,0,'usd',provider_name||'-grace-token') returning id into session_id;
    order_id:=pg_temp.grace_paid_order(session_id,provider_name||'-grace-payment',subscription_id);
    initial_order_id:=order_id;
    update public.commerce_orders set paid_at=now()-interval '1 month' where id=order_id;
    select g.id into strict grant_id from public.commerce_access_grants g where g.order_id=initial_order_id;

    perform public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'initial-paid', paid_end - interval '1 month', paid_end,p_funding_order_id=>order_id);

    -- Failure payload contains the *unpaid* next period. Never advance entitlement.
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'failure-1', paid_end, next_paid_end);
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.current_period_end <> paid_end or access_row.grace_expires_at <> grace_end
      or (result->>'access_deadline')::timestamptz <> grace_end then
      raise exception '%: failed billing advanced the paid period or grace', provider_name;
    end if;

    -- Distinct retry IDs and larger grace arguments cannot reset the deadline.
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'failure-2', paid_end, now() + interval '1 year', false, '{}', 30);
    if (result->>'access_deadline')::timestamptz <> grace_end then
      raise exception '%: repeated failure reset grace', provider_name;
    end if;
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'failure-2', now(), next_paid_end);
    if result->>'reason' <> 'already_processed' then raise exception 'Duplicate event was applied'; end if;

    order_id:=pg_temp.grace_paid_order(session_id,provider_name||'-next-payment',subscription_id);
    perform public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'next-paid', now(), next_paid_end,p_funding_order_id=>order_id);
    -- Delayed renewal data cannot shorten a later paid period.
    perform public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'stale-paid', paid_end - interval '1 month', paid_end,p_funding_order_id=>initial_order_id);
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'revoked', 'stale-terminal', null, paid_end);
    if result->>'reason' <> 'stale_terminal_event' then raise exception 'Stale terminal event applied'; end if;
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.current_period_end <> next_paid_end then raise exception 'Newer paid period shortened'; end if;

    -- Active status updates are not another payment and cannot advance the end.
    perform public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'active', 'generic-update', now(), next_paid_end + interval '1 month');
    select * into strict access_row from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    if access_row.current_period_end <> next_paid_end then raise exception 'Status update advanced period'; end if;

    perform public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'revoked', 'terminal', null, next_paid_end);
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'late-failure', null, next_paid_end + interval '1 year');
    if result->>'reason' <> 'terminal_access_requires_payment' then raise exception 'Failure reactivated grant'; end if;
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'active', 'late-activation', null, next_paid_end + interval '1 year');
    if result->>'reason' <> 'terminal_access_requires_payment' then raise exception 'Status update reactivated grant'; end if;
    if (select status from public.commerce_access_grants where id = grant_id) <> 'revoked' then
      raise exception 'Terminal grant reactivated';
    end if;
    order_id:=pg_temp.grace_paid_order(session_id,provider_name||'-after-terminal-payment',subscription_id);
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'renewed', 'paid-after-terminal', now(), next_paid_end + interval '1 month',p_funding_order_id=>order_id);
    if not (result->>'applied')::boolean
      or (select status from public.commerce_access_grants where id = grant_id) <> 'active' then
      raise exception 'New paid renewal did not recover access';
    end if;

    -- A final verified paid invoice advances the boundary before a completed
    -- snapshot schedules cancellation. The final purchased cycle remains usable.
    perform public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
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
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'past_due', 'partial-refund-failure', null, now() + interval '10 years');
    if (result->>'access_deadline')::timestamptz <> next_paid_end + interval '1 month 3 days' then
      raise exception 'Recognized financial-order fallback extended grace';
    end if;
    update public.commerce_orders set status = 'refunded' where id = order_id;
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
      subscription_id, 'active', 'after-full-refund', null, now() + interval '10 years');
    if result->>'reason' <> 'financial_access_revoked' then raise exception 'Refunded payment restored access'; end if;

    -- A first failure with no stored paid period uses the old actual payment,
    -- never today's time or the failing provider's future billing period.
    delete from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id;
    update public.commerce_orders set status = 'paid',paid_at=now()-interval '1 month'
      where provider=provider_name and provider_subscription_id=subscription_id;
    update public.commerce_access_grants set status = 'active', expires_at = null where id = grant_id;
    result := public.apply_commerce_subscription_lifecycle_funded(provider_name, 'grace-account',
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
    'public.apply_commerce_subscription_lifecycle_funded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer,uuid)', 'execute') then
    raise exception 'Lifecycle RPC exposed to client roles';
  end if;
end;
$$;
rollback;
