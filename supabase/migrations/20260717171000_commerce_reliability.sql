-- Commerce reliability boundaries. Checkout fulfillment happens in one
-- transaction, and the database (not a race-prone read-before-write check)
-- enforces booking exclusivity.

create extension if not exists btree_gist with schema extensions;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'commerce_bookings_no_overlap'
      and conrelid = 'public.commerce_bookings'::regclass
  ) then
    alter table public.commerce_bookings
      add constraint commerce_bookings_no_overlap
      exclude using gist (
        creator_id with =,
        tstzrange(starts_at, ends_at, '[)') with &&
      ) where (status <> 'canceled');
  end if;
end;
$$;

create or replace function public.create_fulfilled_commerce_order(
  p_product_id uuid,
  p_buyer_email text,
  p_buyer_name text,
  p_provider text,
  p_provider_checkout_id text,
  p_gross_amount integer,
  p_platform_fee_bps integer,
  p_platform_fee_amount integer,
  p_processor_fee_amount integer,
  p_net_amount integer,
  p_currency text,
  p_metadata jsonb,
  p_access_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  product public.commerce_products%rowtype;
  created_order public.commerce_orders%rowtype;
begin
  select * into product
  from public.commerce_products
  where id = p_product_id
  for update;

  if product.id is null or product.status <> 'published' then
    raise exception 'This product is not available';
  end if;
  if product.inventory_limit is not null and product.sales_count >= product.inventory_limit then
    raise exception 'This product is sold out';
  end if;
  if p_gross_amount < 0 or p_net_amount < 0 or p_platform_fee_amount < 0
    or p_processor_fee_amount < 0 then
    raise exception 'Invalid order amounts';
  end if;
  if p_currency <> product.currency then
    raise exception 'Order currency does not match product';
  end if;

  insert into public.commerce_orders(
    product_id, creator_id, buyer_email, buyer_name, status, provider,
    provider_checkout_id, provider_payment_id, gross_amount, platform_fee_bps,
    platform_fee_amount, processor_fee_amount, tax_amount, net_amount, currency,
    metadata, paid_at
  ) values (
    product.id, product.creator_id, lower(p_buyer_email), nullif(p_buyer_name, ''),
    'paid', p_provider, p_provider_checkout_id, p_provider_checkout_id,
    p_gross_amount, p_platform_fee_bps, p_platform_fee_amount,
    p_processor_fee_amount, 0, p_net_amount, p_currency,
    coalesce(p_metadata, '{}'::jsonb), now()
  )
  returning * into created_order;

  if p_access_token_hash is not null then
    insert into public.commerce_access_grants(
      order_id, product_id, creator_id, buyer_email, token_hash
    ) values (
      created_order.id, product.id, product.creator_id,
      lower(p_buyer_email), p_access_token_hash
    );
  end if;

  return jsonb_build_object(
    'order_id', created_order.id,
    'product_id', product.id,
    'creator_id', product.creator_id
  );
end;
$$;

revoke all on function public.create_fulfilled_commerce_order(
  uuid, text, text, text, text, integer, integer, integer, integer,
  integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.create_fulfilled_commerce_order(
  uuid, text, text, text, text, integer, integer, integer, integer,
  integer, text, jsonb, text
) to service_role;

-- Claiming a payment webhook is a leased compare-and-swap. Only one consumer
-- can process an event at a time; a crashed worker can be retried after the
-- lease expires without allowing concurrent duplicate fulfillment.
alter table public.billing_events drop constraint if exists billing_events_status_check;
alter table public.billing_events add constraint billing_events_status_check
  check (status in ('pending', 'processing', 'processed', 'failed'));

create or replace function public.claim_billing_event(
  p_webhook_id text,
  p_event_type text,
  p_payload jsonb,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  insert into public.billing_events(
    webhook_id, event_type, payload, status, occurred_at
  ) values (
    p_webhook_id, p_event_type, p_payload, 'processing', p_occurred_at
  )
  on conflict (webhook_id) do nothing
  returning id into claimed_id;

  if claimed_id is not null then return true; end if;

  update public.billing_events
  set status = 'processing', attempts = attempts + 1, error_message = null
  where webhook_id = p_webhook_id
    and status <> 'processed'
    and (status = 'failed' or updated_at < now() - interval '2 minutes')
  returning id into claimed_id;

  return claimed_id is not null;
end;
$$;

revoke all on function public.claim_billing_event(text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_billing_event(text, text, jsonb, timestamptz)
  to service_role;
