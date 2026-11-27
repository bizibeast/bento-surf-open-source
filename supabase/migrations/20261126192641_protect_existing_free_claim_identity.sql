-- Free offers remain anonymously claimable, but an existing buyer's private
-- grant can only be recovered through their verified customer library identity.
create or replace function public.claim_free_commerce_offer(
  p_product_id uuid,
  p_buyer_email text,
  p_buyer_name text,
  p_provider_checkout_id text,
  p_metadata jsonb,
  p_access_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.commerce_products%rowtype;
  order_row public.commerce_orders%rowtype;
  fulfillment jsonb;
  normalized_email text := lower(trim(p_buyer_email));
begin
  if normalized_email = '' or length(normalized_email) > 254 then
    raise exception 'A valid buyer email is required';
  end if;
  if p_access_token_hash is null or p_access_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid access capability is required';
  end if;

  select * into product_row
  from public.commerce_products
  where id = p_product_id
  for update;

  if product_row.id is null
    or product_row.status <> 'published'
    or product_row.pricing_type::text <> 'free'
    or product_row.kind::text not in (
      'digital_product', 'coaching_call', 'course', 'webinar',
      'paid_community', 'membership', 'custom_product'
    ) then
    raise exception 'This free offer is not available';
  end if;

  select * into order_row
  from public.commerce_orders
  where provider = 'free'
    and provider_checkout_id = p_provider_checkout_id
  limit 1;

  if order_row.id is null then
    fulfillment := public.create_fulfilled_commerce_order(
      product_row.id,
      normalized_email,
      coalesce(p_buyer_name, ''),
      'free',
      p_provider_checkout_id,
      0,
      0,
      0,
      0,
      0,
      product_row.currency,
      coalesce(p_metadata, '{}'::jsonb),
      p_access_token_hash
    );
    -- The product lock serializes competing claims before the order lookup.
    -- Keep a future idempotent implementation from leaking a reused order.
    if (fulfillment->>'already_processed')::boolean is true then
      return jsonb_build_object('created_new_order', false);
    end if;
    return fulfillment || jsonb_build_object('created_new_order', true);
  end if;

  if order_row.product_id <> product_row.id
    or lower(trim(order_row.buyer_email)) <> normalized_email then
    raise exception 'Free claim identity does not match the original order';
  end if;

  -- An anonymous email address is not proof of ownership. Never mint a new
  -- capability, reveal the original order, update the customer's identity or
  -- revive a grant on repeat claims. Recovery uses verified library sign-in.
  return jsonb_build_object('created_new_order', false);
end;
$$;

revoke all on function public.claim_free_commerce_offer(
  uuid, text, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.claim_free_commerce_offer(
  uuid, text, text, text, jsonb, text
) to service_role;

