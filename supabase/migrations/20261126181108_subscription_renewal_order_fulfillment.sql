-- Recurring invoices are new financial orders for an existing inventory seat.
-- Keep checkout snapshots stable and assign each subscription payment its own
-- order checkout key, including providers that reuse their subscription ID.

create or replace function public.commerce_count_paid_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_count boolean := false;
  current_inventory integer;
  current_sales integer;
begin
  if tg_op = 'INSERT' then
    should_count := new.status = 'paid';
  else
    should_count := new.status = 'paid'
      and old.status is distinct from 'paid'
      and old.status is distinct from 'disputed';
  end if;

  if should_count
    and coalesce(new.metadata->>'commerce_intent', '') <> 'priority_dm_followup' then
    select inventory_limit, sales_count
      into current_inventory, current_sales
      from public.commerce_products
      where id = new.product_id
      for update;

    -- A recurring invoice extends an existing seat. Derive this from paid
    -- financial history, never an untrusted metadata flag or mutable pricing.
    -- Partial refunds retain the acquired seat; full refunds/disputes do not
    -- establish renewal eligibility.
    if nullif(trim(new.provider_subscription_id), '') is not null
      and exists (
        select 1 from public.commerce_orders prior_order
        where prior_order.id <> new.id
          and prior_order.status in ('paid', 'partially_refunded')
          and prior_order.provider = new.provider
          and prior_order.provider_account_id is not distinct from new.provider_account_id
          and prior_order.provider_subscription_id = new.provider_subscription_id
          and prior_order.product_id = new.product_id
          and prior_order.creator_id = new.creator_id
          and lower(trim(prior_order.buyer_email)) = lower(trim(new.buyer_email))
      ) then
      return new;
    end if;

    if current_inventory is not null and current_sales >= current_inventory then
      raise exception 'Product is sold out';
    end if;

    update public.commerce_products
      set sales_count = sales_count + 1
      where id = new.product_id;
  end if;
  return new;
end;
$$;

revoke all on function public.commerce_count_paid_order()
  from public, anon, authenticated;

create or replace function public.fulfill_provider_commerce_order(
  p_product_id uuid,
  p_buyer_email text,
  p_buyer_name text,
  p_provider text,
  p_provider_account_id text,
  p_provider_checkout_id text,
  p_provider_payment_id text,
  p_provider_subscription_id text,
  p_gross_amount integer,
  p_platform_fee_bps integer,
  p_platform_fee_amount integer,
  p_processor_fee_amount integer,
  p_tax_amount integer,
  p_net_amount integer,
  p_currency text,
  p_metadata jsonb,
  p_access_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.commerce_products%rowtype;
  session_row public.commerce_payment_sessions%rowtype;
  account_row public.creator_payment_accounts%rowtype;
  created_order public.commerce_orders%rowtype;
  prior_subscription_order public.commerce_orders%rowtype;
  normalized_subscription_id text := nullif(trim(p_provider_subscription_id), '');
  is_subscription_renewal boolean := false;
  created_new_order boolean := false;
  metadata_session_id text := coalesce(p_metadata->>'bento_session_id', '');
begin
  if nullif(trim(p_provider), '') is null
    or nullif(trim(p_provider_payment_id), '') is null
    or nullif(trim(p_buyer_email), '') is null then
    raise exception 'Missing provider payment details';
  end if;

  -- Serialize duplicate payment deliveries before inventory checks, including
  -- deliveries arriving while the first transaction is still uncommitted.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'commerce-payment:' || lower(trim(p_provider)) || ':' || trim(p_provider_payment_id), 0
  ));

  -- Idempotency wins before any mutable inventory check.
  select * into created_order
  from public.commerce_orders
  where provider = lower(trim(p_provider))
    and provider_payment_id = trim(p_provider_payment_id);

  if created_order.id is not null then
    return jsonb_build_object(
      'order_id', created_order.id,
      'product_id', created_order.product_id,
      'creator_id', created_order.creator_id,
      'already_processed', true
    );
  end if;

  select * into session_row
  from public.commerce_payment_sessions
  where product_id = p_product_id
    and provider = lower(trim(p_provider))
    and (
      (metadata_session_id <> '' and id::text = metadata_session_id)
      or (metadata_session_id = '' and (
        provider_checkout_id = p_provider_checkout_id
        or id::text = p_provider_checkout_id
      ))
    )
  order by created_at desc
  limit 1
  for update;

  if session_row.id is null then
    raise exception 'Bento checkout session was not found';
  end if;
  if session_row.status in ('failed', 'expired', 'canceled') then
    raise exception 'Bento checkout session is no longer payable';
  end if;
  if lower(trim(session_row.buyer_email)) <> lower(trim(p_buyer_email)) then
    raise exception 'Buyer email does not match checkout';
  end if;
  if p_gross_amount <> session_row.gross_amount
    or p_platform_fee_bps <> session_row.platform_fee_bps
    or p_platform_fee_amount <> session_row.platform_fee_amount
    or lower(trim(p_currency)) <> session_row.currency then
    raise exception 'Order amounts do not match checkout';
  end if;
  if p_gross_amount < 0
    or p_platform_fee_amount < 0
    or p_processor_fee_amount < 0
    or p_tax_amount < 0
    or p_net_amount < 0
    or p_net_amount <> (
      p_gross_amount - p_platform_fee_amount - p_processor_fee_amount
    ) then
    raise exception 'Invalid order amounts';
  end if;

  select * into account_row
  from public.creator_payment_accounts
  where id = session_row.connection_id;
  if account_row.id is null
    or account_row.creator_id <> session_row.creator_id
    or account_row.provider <> session_row.provider
    or account_row.provider_account_id is distinct from p_provider_account_id then
    raise exception 'Payment account does not match checkout';
  end if;

  select * into product_row
  from public.commerce_products
  where id = session_row.product_id
    and creator_id = session_row.creator_id
  for update;

  if product_row.id is null then
    raise exception 'Product was not found';
  end if;
  if normalized_subscription_id is not null then
    select * into prior_subscription_order
    from public.commerce_orders prior_order
    where prior_order.status in ('paid', 'partially_refunded')
      and prior_order.provider = lower(trim(p_provider))
      and prior_order.provider_account_id is not distinct from p_provider_account_id
      and prior_order.provider_subscription_id = normalized_subscription_id
    order by prior_order.created_at asc, prior_order.id asc
    limit 1;

    if prior_subscription_order.id is not null then
      if prior_subscription_order.product_id <> product_row.id
        or prior_subscription_order.creator_id <> product_row.creator_id
        or lower(trim(prior_subscription_order.buyer_email)) <> lower(trim(p_buyer_email))
        or (
          prior_subscription_order.metadata->>'bento_session_id' = session_row.id::text
          or prior_subscription_order.provider_checkout_id = session_row.provider_checkout_id
          or prior_subscription_order.provider_checkout_id = session_row.id::text
        ) is not true then
        raise exception 'Subscription does not match checkout';
      end if;
      is_subscription_renewal := true;
    elsif exists (
      select 1 from public.commerce_orders prior_order
      where prior_order.status in ('paid', 'partially_refunded')
        and prior_order.provider = session_row.provider
        and prior_order.product_id = session_row.product_id
        and (prior_order.metadata->>'bento_session_id' = session_row.id::text
          or prior_order.provider_checkout_id = session_row.provider_checkout_id
          or prior_order.provider_checkout_id = session_row.id::text)
    ) then
      raise exception 'Subscription does not match checkout';
    end if;
  end if;

  if not is_subscription_renewal
    and coalesce(p_metadata->>'commerce_intent', '') <> 'priority_dm_followup'
    and product_row.inventory_limit is not null
    and product_row.sales_count >= product_row.inventory_limit then
    raise exception 'This product is sold out';
  end if;

  insert into public.commerce_orders(
    product_id, creator_id, buyer_email, buyer_name, status, provider,
    provider_account_id, provider_checkout_id, provider_payment_id,
    provider_subscription_id, gross_amount, platform_fee_bps,
    platform_fee_amount, processor_fee_amount, tax_amount, net_amount, currency,
    metadata, paid_at
  ) values (
    product_row.id, product_row.creator_id, lower(trim(p_buyer_email)),
    case
      when coalesce(p_metadata->>'commerce_intent', '') = 'priority_dm_followup'
        then nullif(trim(session_row.buyer_name), '')
      else nullif(trim(p_buyer_name), '')
    end,
    'paid', lower(trim(p_provider)),
    p_provider_account_id,
    case when normalized_subscription_id is not null
      then lower(trim(p_provider)) || ':subscription-payment:' || trim(p_provider_payment_id)
      else p_provider_checkout_id end,
    trim(p_provider_payment_id), normalized_subscription_id, p_gross_amount,
    p_platform_fee_bps, p_platform_fee_amount, p_processor_fee_amount,
    p_tax_amount, p_net_amount, lower(trim(p_currency)),
    coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object('bento_session_id', session_row.id::text),
    now()
  )
  on conflict (provider, provider_payment_id) do nothing
  returning * into created_order;

  if created_order.id is null then
    select * into created_order
    from public.commerce_orders
    where provider = lower(trim(p_provider))
      and provider_payment_id = trim(p_provider_payment_id);
  else
    created_new_order := true;
  end if;

  -- Renewals retain the first durable grant even if a caller supplies a new
  -- token. Legacy subscriptions without a grant may still acquire one.
  if created_new_order and p_access_token_hash is not null
    and (not is_subscription_renewal or not exists (
      select 1 from public.commerce_access_grants grant_row
      join public.commerce_orders order_row on order_row.id = grant_row.order_id
      where order_row.provider = lower(trim(p_provider))
        and order_row.provider_account_id is not distinct from p_provider_account_id
        and order_row.provider_subscription_id = normalized_subscription_id
        and order_row.product_id = product_row.id
        and lower(trim(order_row.buyer_email)) = lower(trim(p_buyer_email))
    )) then
    insert into public.commerce_access_grants(
      order_id, product_id, creator_id, buyer_email, token_hash
    ) values (
      created_order.id, product_row.id, product_row.creator_id,
      lower(trim(p_buyer_email)), p_access_token_hash
    ) on conflict (token_hash) do nothing;
  end if;

  return jsonb_build_object(
    'order_id', created_order.id,
    'product_id', created_order.product_id,
    'creator_id', created_order.creator_id,
    'already_processed', not created_new_order
  );
end;
$$;

revoke all on function public.fulfill_provider_commerce_order(
  uuid, text, text, text, text, text, text, text, integer, integer, integer,
  integer, integer, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.fulfill_provider_commerce_order(
  uuid, text, text, text, text, text, text, text, integer, integer, integer,
  integer, integer, integer, text, jsonb, text
) to service_role;
