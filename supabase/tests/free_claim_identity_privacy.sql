-- Real PostgreSQL contract. Fixture data rolls back; no provider/email calls.
begin;
do $$
declare
  owner_id uuid := gen_random_uuid();
  offer_id uuid;
  first_claim jsonb;
  repeated_claim jsonb;
  original_grant uuid;
  checkout_id text := 'free-claim-privacy-' || gen_random_uuid();
  victim_email text := 'victim-' || gen_random_uuid() || '@example.com';
begin
  insert into auth.users(id, email) values(owner_id, 'claim-owner-' || owner_id || '@example.com');
  insert into public.commerce_products(creator_id, kind, status, slug, public_slug, title,
    description, pricing_type, price_amount, currency, inventory_limit, settings)
  values(owner_id, 'paid_community', 'published', 'free-privacy-' || gen_random_uuid(),
    'free-privacy-' || gen_random_uuid(), 'Free private community', 'Join our community',
    'free', 0, 'usd', 1, '{"welcomeMessage":"Welcome"}') returning id into offer_id;

  first_claim := public.claim_free_commerce_offer(offer_id, victim_email,
    'Original buyer', checkout_id, '{"access_token_ciphertext":"original-private-capability"}', repeat('a',64));
  if (first_claim->>'created_new_order')::boolean is not true or first_claim->>'order_id' is null then
    raise exception 'Initial anonymous claim must create its own access';
  end if;
  select id into strict original_grant from public.commerce_access_grants
    where order_id = (first_claim->>'order_id')::uuid;
  update public.commerce_access_grants set community_role = 'moderator', member_name = 'Original moderator'
    where id = original_grant;

  -- The only knowledge supplied here is the same freely entered email address.
  repeated_claim := public.claim_free_commerce_offer(offer_id, victim_email,
    'Impersonator', checkout_id, '{"access_token_ciphertext":"attacker-private-capability"}', repeat('b',64));
  if repeated_claim <> '{"created_new_order":false}'::jsonb then
    raise exception 'Repeated anonymous claim disclosed original identifiers: %', repeated_claim;
  end if;
  if exists(select 1 from public.commerce_customer_access_tokens where grant_id = original_grant) then
    raise exception 'Repeated anonymous claim minted capability for original moderator';
  end if;
  if (select token_hash from public.commerce_access_grants where id = original_grant) <> repeat('a',64)
    or (select member_name from public.commerce_access_grants where id = original_grant) <> 'Original moderator'
    or (select metadata->>'access_token_ciphertext' from public.commerce_orders where id = (first_claim->>'order_id')::uuid)
      <> 'original-private-capability' then
    raise exception 'Repeated anonymous claim changed original buyer or capability';
  end if;
  if exists(select 1 from public.commerce_customers where email_normalized = victim_email and name = 'Impersonator') then
    raise exception 'Repeated anonymous claim changed the verified library identity';
  end if;

  -- The response must not reveal active vs revoked grants, and cannot restore one.
  update public.commerce_access_grants set status = 'revoked' where id = original_grant;
  repeated_claim := public.claim_free_commerce_offer(offer_id, victim_email,
    'Impersonator', checkout_id, '{}', repeat('c',64));
  if repeated_claim <> '{"created_new_order":false}'::jsonb
    or (select status from public.commerce_access_grants where id = original_grant) <> 'revoked' then
    raise exception 'Repeated anonymous claim leaked or restored revoked access';
  end if;
  if (select count(*) from public.commerce_orders where product_id = offer_id) <> 1
    or (select count(*) from public.commerce_access_grants where product_id = offer_id) <> 1
    or (select sales_count from public.commerce_products where id = offer_id) <> 1 then
    raise exception 'Repeated claims duplicated order, grant or inventory seat';
  end if;
end;
$$;
rollback;
