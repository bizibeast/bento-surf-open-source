-- Run with psql -v ON_ERROR_STOP=1 after migrations. Fixtures always roll back.
begin;

create function pg_temp.fulfill_subscription_test(
  p_session_id uuid, p_payment_id text, p_subscription_id text,
  p_override jsonb default '{}'::jsonb
) returns jsonb language plpgsql as $$
declare s public.commerce_payment_sessions%rowtype;
begin
  select * into strict s from public.commerce_payment_sessions where id = p_session_id;
  return public.fulfill_provider_commerce_order(
    coalesce((p_override->>'product_id')::uuid, s.product_id),
    coalesce(p_override->>'buyer_email', s.buyer_email), 'Original buyer', s.provider,
    case when p_override ? 'account_id' then p_override->>'account_id' else
      (select provider_account_id from public.creator_payment_accounts where id = s.connection_id) end,
    coalesce(p_override->>'checkout_id', s.provider_checkout_id), p_payment_id, p_subscription_id,
    coalesce((p_override->>'gross_amount')::integer, s.gross_amount),
    s.platform_fee_bps, s.platform_fee_amount, 0, 0,
    coalesce((p_override->>'gross_amount')::integer, s.gross_amount) - s.platform_fee_amount,
    coalesce(p_override->>'currency', s.currency),
    jsonb_build_object('bento_session_id', s.id::text)
      || coalesce(p_override->'metadata', '{}'::jsonb),
    coalesce(p_override->>'token_hash', s.access_token_hash)
  );
end;
$$;

create function pg_temp.expect_subscription_rejection(
  p_session uuid, p_payment text, p_subscription text,
  p_override jsonb, p_expected_error text
) returns void language plpgsql as $$
begin
  begin
    perform pg_temp.fulfill_subscription_test(p_session, p_payment, p_subscription, p_override);
  exception when others then
    if position(p_expected_error in sqlerrm) = 0 then
      raise exception 'Expected error %, received %', p_expected_error, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Expected fulfillment rejection: %', p_expected_error;
end;
$$;

do $$
declare
  owner_id uuid := gen_random_uuid();
  account_id uuid;
  product_id uuid;
  other_product_id uuid;
  session_id uuid;
  other_session_id uuid;
  original_grant uuid;
  provider_name text;
  subscription_id text;
  first_result jsonb;
  renewal_result jsonb;
  again_result jsonb;
  order_row public.commerce_orders%rowtype;
  sales integer;
begin
  insert into auth.users(id, email) values (owner_id, 'renewal-test-' || owner_id || '@example.test');

  foreach provider_name in array array['stripe', 'razorpay', 'paypal', 'dodo', 'creem', 'polar'] loop
    subscription_id := provider_name || '-sub-original';
    insert into public.creator_payment_accounts(creator_id, provider, provider_account_id)
    values (owner_id, provider_name, provider_name || '-test-account') returning id into account_id;

    insert into public.commerce_products(creator_id, kind, status, slug, public_slug, title,
      pricing_type, price_amount, currency, billing_interval)
    values (owner_id, 'membership', 'published', 'renewal-' || gen_random_uuid(), 'renewal-' || gen_random_uuid(), 'Membership',
      'subscription', 1000, 'usd', 'month') returning id into product_id;
    insert into public.commerce_products(creator_id, kind, status, slug, public_slug, title,
      pricing_type, price_amount, currency, billing_interval)
    values (owner_id, 'membership', 'published', 'other-' || gen_random_uuid(), 'other-' || gen_random_uuid(), 'Other membership',
      'subscription', 1000, 'usd', 'month') returning id into other_product_id;

    -- Two sessions started before inventory was limited to one seat.
    insert into public.commerce_payment_sessions(product_id, creator_id, connection_id,
      provider, provider_checkout_id, buyer_email, gross_amount, platform_fee_bps,
      platform_fee_amount, currency, access_token_hash)
    values (product_id, owner_id, account_id, provider_name, subscription_id,
      'buyer@example.test', 1000, 500, 50, 'usd', provider_name || '-durable-token')
    returning id into session_id;
    insert into public.commerce_payment_sessions(product_id, creator_id, connection_id,
      provider, provider_checkout_id, buyer_email, gross_amount, platform_fee_bps,
      platform_fee_amount, currency, access_token_hash)
    values (product_id, owner_id, account_id, provider_name, provider_name || '-sub-second',
      'second@example.test', 1000, 500, 50, 'usd', provider_name || '-second-token')
    returning id into other_session_id;
    update public.commerce_products set inventory_limit = 1 where id = product_id;

    first_result := pg_temp.fulfill_subscription_test(session_id, provider_name || '-payment-1', subscription_id);
    select sales_count into sales from public.commerce_products where id = product_id;
    if sales <> 1 then raise exception 'First subscription did not consume one seat'; end if;
    select id into strict original_grant from public.commerce_access_grants
      where order_id = (first_result->>'order_id')::uuid;
    perform pg_temp.expect_subscription_rejection(other_session_id, provider_name || '-second-payment',
      provider_name || '-sub-second', '{}', 'sold out');

    -- Full refunds and disputes do not establish a retained paid entitlement.
    update public.commerce_orders set status = 'refunded', refunded_amount = 1000
      where id = (first_result->>'order_id')::uuid;
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-refunded-renewal',
      subscription_id, '{}', 'sold out');
    update public.commerce_orders set status = 'disputed', refunded_amount = 0
      where id = (first_result->>'order_id')::uuid;
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-disputed-renewal',
      subscription_id, '{}', 'sold out');

    -- A partial refund retains access and the acquired seat. The first full
    -- renewal must still recognize this initial financial history.
    update public.commerce_orders set status = 'partially_refunded', refunded_amount = 100
      where id = (first_result->>'order_id')::uuid;

    if provider_name = 'dodo' then
      -- Deployed providers may have used the subscription checkout key for the
      -- initial order before per-payment keys and session metadata existed.
      update public.commerce_orders set provider_checkout_id = subscription_id, metadata = '{}'
        where id = (first_result->>'order_id')::uuid;
    end if;
    update public.commerce_payment_sessions set status = 'paid' where id = session_id;
    -- Current product edits do not change the immutable checkout contract.
    update public.commerce_products set status = 'archived', price_amount = 2500,
      currency = 'eur', pricing_type = 'one_time', billing_interval = null where id = product_id;
    renewal_result := pg_temp.fulfill_subscription_test(session_id, provider_name || '-payment-2',
      subscription_id, jsonb_build_object('token_hash', provider_name || '-unwanted-new-token',
        'checkout_id', case when provider_name in ('razorpay', 'paypal')
          then provider_name || '-invoice-2' else subscription_id end));
    if first_result->>'order_id' = renewal_result->>'order_id'
      or (renewal_result->>'already_processed')::boolean then
      raise exception 'Renewal must create a separate immutable financial order';
    end if;
    select * into strict order_row from public.commerce_orders
      where id = (renewal_result->>'order_id')::uuid;
    if order_row.provider_checkout_id <> provider_name || ':subscription-payment:' || provider_name || '-payment-2'
      or order_row.metadata->>'bento_session_id' <> session_id::text
      or order_row.buyer_email <> 'buyer@example.test'
      or order_row.gross_amount <> 1000 or order_row.currency <> 'usd' then
      raise exception 'Renewal lost payment/session/buyer snapshot';
    end if;
    if (select provider_checkout_id from public.commerce_payment_sessions where id = session_id) <> subscription_id then
      raise exception 'Renewal mutated original provider checkout binding';
    end if;
    if (select sales_count from public.commerce_products where id = product_id) <> 1 then
      raise exception 'Renewal consumed another inventory seat';
    end if;
    if (select count(*) from public.commerce_access_grants where commerce_access_grants.product_id = order_row.product_id
      and buyer_email = 'buyer@example.test') <> 1 then
      raise exception 'Renewal created another access token';
    end if;
    perform public.apply_commerce_subscription_lifecycle(provider_name, provider_name || '-test-account',
      subscription_id, 'renewed', provider_name || '-event-2', now(), now() + interval '1 month');
    if (select access_grant_id from public.commerce_subscription_access
      where provider = provider_name and provider_subscription_id = subscription_id) <> original_grant then
      raise exception 'Renewal did not reuse original subscription access grant';
    end if;

    -- Providers that resend the original checkout key still produce one order
    -- per payment without colliding with either initial or earlier renewal.
    perform pg_temp.fulfill_subscription_test(session_id, provider_name || '-payment-3', subscription_id);
    if (select count(*) from public.commerce_orders where commerce_orders.product_id = order_row.product_id) <> 3
      or (select sales_count from public.commerce_products where id = product_id) <> 1 then
      raise exception 'Repeated checkout key lost an invoice or consumed another seat';
    end if;

    -- Idempotency remains first even after mutable session state changes.
    update public.commerce_payment_sessions set status = 'expired' where id = session_id;
    again_result := pg_temp.fulfill_subscription_test(session_id, provider_name || '-payment-2', subscription_id);
    if again_result->>'order_id' <> renewal_result->>'order_id'
      or not (again_result->>'already_processed')::boolean then
      raise exception 'Repeated provider payment was not idempotent';
    end if;
    update public.commerce_payment_sessions set status = 'paid' where id = session_id;

    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-account', subscription_id,
      '{"account_id":"other-account"}', 'Payment account does not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-null-account', subscription_id,
      '{"account_id":null}', 'Payment account does not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-sub', 'wrong-sub',
      '{}', 'Subscription does not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-product', subscription_id,
      jsonb_build_object('product_id', other_product_id), 'Bento checkout session was not found');
    perform pg_temp.expect_subscription_rejection(other_session_id, provider_name || '-reused-sub', subscription_id,
      '{}', 'Subscription does not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-buyer', subscription_id,
      '{"buyer_email":"intruder@example.test"}', 'Buyer email does not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-amount', subscription_id,
      '{"gross_amount":999}', 'Order amounts do not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-currency', subscription_id,
      '{"currency":"eur"}', 'Order amounts do not match checkout');
    perform pg_temp.expect_subscription_rejection(session_id, provider_name || '-wrong-session', subscription_id,
      jsonb_build_object('metadata', jsonb_build_object('bento_session_id', gen_random_uuid())),
      'Bento checkout session was not found');
  end loop;
end;
$$;

-- One-time orders keep their checkout key and still enforce inventory.
do $$
declare
  owner_id uuid := gen_random_uuid();
  account_id uuid;
  product_id uuid;
  session_id uuid;
  other_session_id uuid;
  result jsonb;
begin
  insert into auth.users(id, email) values(owner_id, 'one-time-' || owner_id || '@example.test');
  insert into public.creator_payment_accounts(creator_id, provider, provider_account_id)
    values(owner_id, 'paypal', 'one-time-account') returning id into account_id;
  insert into public.commerce_products(creator_id, kind, status, slug, public_slug, title,
    pricing_type, price_amount, currency)
    values(owner_id, 'digital_product', 'published', 'one-time-' || gen_random_uuid(), 'one-time-' || gen_random_uuid(),
      'Download', 'one_time', 1000, 'usd') returning id into product_id;
  insert into public.commerce_payment_sessions(product_id, creator_id, connection_id, provider,
    provider_checkout_id, buyer_email, gross_amount, platform_fee_bps, platform_fee_amount, currency)
    values(product_id, owner_id, account_id, 'paypal', 'one-time-checkout', 'buyer@example.test',
      1000, 500, 50, 'usd') returning id into session_id;
  insert into public.commerce_payment_sessions(product_id, creator_id, connection_id, provider,
    provider_checkout_id, buyer_email, gross_amount, platform_fee_bps, platform_fee_amount, currency)
    values(product_id, owner_id, account_id, 'paypal', 'one-time-other-checkout', 'other@example.test',
      1000, 500, 50, 'usd') returning id into other_session_id;
  update public.commerce_products set inventory_limit = 1 where id = product_id;
  result := pg_temp.fulfill_subscription_test(session_id, 'one-time-payment', null);
  if (select provider_checkout_id from public.commerce_orders where id=(result->>'order_id')::uuid) <> 'one-time-checkout' then
    raise exception 'One-time checkout ID changed';
  end if;
  perform pg_temp.expect_subscription_rejection(other_session_id, 'one-time-second', null, '{}', 'sold out');
  update public.commerce_orders set status = 'disputed' where id=(result->>'order_id')::uuid;
  update public.commerce_orders set status = 'paid' where id=(result->>'order_id')::uuid;
  if (select sales_count from public.commerce_products where id=product_id) <> 1 then
    raise exception 'Dispute restoration consumed inventory twice';
  end if;
  if not (pg_temp.fulfill_subscription_test(session_id, 'one-time-payment', null)->>'already_processed')::boolean then
    raise exception 'One-time payment idempotency changed';
  end if;
end;
$$;

-- New/replaced privileged functions are not public RPC entry points.
do $$
begin
  if has_function_privilege('anon',
    'public.fulfill_provider_commerce_order(uuid,text,text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,text,jsonb,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.commerce_count_paid_order()', 'EXECUTE') then
    raise exception 'Fulfillment or inventory privilege leaked';
  end if;
end;
$$;
rollback;
