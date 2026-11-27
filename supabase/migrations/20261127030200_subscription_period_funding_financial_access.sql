-- Bind durable subscription access to the financial order that paid its current
-- service period. Keep the original order/grant/token relationship unchanged.
alter table public.commerce_orders
  add column subscription_period_start timestamptz,
  add column subscription_period_end timestamptz,
  add constraint commerce_orders_subscription_period_check check (
    (subscription_period_start is null and subscription_period_end is null)
    or (subscription_period_start is not null and subscription_period_end > subscription_period_start)
  );
alter table public.commerce_subscription_access
  add column funding_order_id uuid references public.commerce_orders(id) on delete set null;
create index commerce_subscription_access_funding_order_idx
  on public.commerce_subscription_access(funding_order_id) where funding_order_id is not null;

-- Recognized immutable subscription history retains one inventory seat.
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
    -- A previously captured payment keeps its inventory seat even after a
    -- financial reversal; only a new verified paid period restores access.
    if nullif(trim(new.provider_subscription_id), '') is not null
      and exists (
        select 1 from public.commerce_orders prior_order
        where prior_order.id <> new.id
          and prior_order.status in ('paid','partially_refunded','refunded','disputed')
          and prior_order.paid_at is not null and prior_order.gross_amount > 0
          and nullif(new.metadata->>'bento_session_id','') is not null
          and (prior_order.metadata->>'bento_session_id'=new.metadata->>'bento_session_id'
            or (nullif(prior_order.metadata->>'bento_session_id','') is null and exists (
              select 1 from public.commerce_payment_sessions legacy_session
              where legacy_session.id::text=new.metadata->>'bento_session_id'
                and prior_order.provider_checkout_id in (legacy_session.provider_checkout_id,legacy_session.id::text)
                and legacy_session.provider=new.provider
                and legacy_session.product_id=new.product_id
                and legacy_session.creator_id=new.creator_id
                and lower(trim(legacy_session.buyer_email))=lower(trim(new.buyer_email)))))
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

-- A uniquely named funded API atomically commits verified periods. Existing
-- workers retain the original RPC name and exact signature through a wrapper.
create or replace function public.fulfill_provider_commerce_order_with_period(
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
  p_access_token_hash text default null,
  p_subscription_period_start timestamptz default null,
  p_subscription_period_end timestamptz default null
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
  funding_result jsonb;
begin
  if nullif(trim(p_provider), '') is null
    or nullif(trim(p_provider_payment_id), '') is null
    or nullif(trim(p_buyer_email), '') is null then
    raise exception 'Missing provider payment details';
  end if;

  if p_subscription_period_start is not null or p_subscription_period_end is not null then
    if normalized_subscription_id is null or p_gross_amount <= 0 or p_subscription_period_start is null
      or p_subscription_period_end is null or p_subscription_period_end <= p_subscription_period_start then
      raise exception 'A subscription payment requires a complete verified service period';
    end if;
  end if;
  if normalized_subscription_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      lower(trim(p_provider)) || ':' || coalesce(p_provider_account_id,'') || ':' || normalized_subscription_id,0));
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
    if p_subscription_period_start is not null then
      if created_order.product_id <> p_product_id
        or lower(trim(created_order.buyer_email)) <> lower(trim(p_buyer_email))
        or created_order.provider_account_id is distinct from p_provider_account_id
        or created_order.provider_subscription_id is distinct from normalized_subscription_id
        or nullif(metadata_session_id,'') is null
        or created_order.metadata->>'bento_session_id' is distinct from metadata_session_id then
        raise exception 'Funding payment does not match the immutable checkout';
      end if;
      if created_order.subscription_period_end is not null then
        if created_order.subscription_period_start is distinct from p_subscription_period_start
          or created_order.subscription_period_end is distinct from p_subscription_period_end then
          raise exception 'A paid order service period is immutable';
        end if;
      else
        funding_result := public.apply_commerce_subscription_lifecycle_funded(p_provider,p_provider_account_id,
          normalized_subscription_id,'renewed','atomic-paid:'||created_order.id::text,
          p_subscription_period_start,p_subscription_period_end,p_funding_order_id=>created_order.id);
        if coalesce((funding_result->>'applied')::boolean,false) is false and exists (
          select 1 from public.commerce_access_grants g join public.commerce_orders o on o.id=g.order_id
          where o.provider=lower(trim(p_provider)) and o.provider_account_id is not distinct from p_provider_account_id
            and o.provider_subscription_id=normalized_subscription_id and o.product_id=p_product_id
            and lower(trim(o.buyer_email))=lower(trim(p_buyer_email)) and g.status='active' and g.expires_at is null
        ) then raise exception 'Funding period was not committed'; end if;
      end if;
    end if;
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
    where prior_order.status in ('paid','partially_refunded','refunded','disputed')
      and prior_order.paid_at is not null and prior_order.gross_amount > 0
      and (prior_order.status in ('paid','partially_refunded')
        or prior_order.metadata->>'bento_session_id'=session_row.id::text)
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

  if p_subscription_period_start is not null then
    funding_result := public.apply_commerce_subscription_lifecycle_funded(p_provider,p_provider_account_id,
      normalized_subscription_id,'renewed','atomic-paid:'||created_order.id::text,
      p_subscription_period_start,p_subscription_period_end,p_funding_order_id=>created_order.id);
    if coalesce((funding_result->>'applied')::boolean,false) is false and exists (
      select 1 from public.commerce_access_grants g join public.commerce_orders o on o.id=g.order_id
      where o.provider=lower(trim(p_provider)) and o.provider_account_id is not distinct from p_provider_account_id
        and o.provider_subscription_id=normalized_subscription_id and o.product_id=p_product_id
        and lower(trim(o.buyer_email))=lower(trim(p_buyer_email)) and g.status='active' and g.expires_at is null
    ) then raise exception 'Funding period was not committed'; end if;
  end if;

  return jsonb_build_object(
    'order_id', created_order.id,
    'product_id', created_order.product_id,
    'creator_id', created_order.creator_id,
    'already_processed', not created_new_order
  );
end;
$$;

revoke all on function public.fulfill_provider_commerce_order_with_period(
  uuid, text, text, text, text, text, text, text, integer, integer, integer,
  integer, integer, integer, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.fulfill_provider_commerce_order_with_period(
  uuid, text, text, text, text, text, text, text, integer, integer, integer,
  integer, integer, integer, text, jsonb, text, timestamptz, timestamptz
) to service_role;

-- Preserve the exact seventeen-argument API, including its optional token.
create or replace function public.fulfill_provider_commerce_order(
  p_product_id uuid,p_buyer_email text,p_buyer_name text,p_provider text,p_provider_account_id text,
  p_provider_checkout_id text,p_provider_payment_id text,p_provider_subscription_id text,
  p_gross_amount integer,p_platform_fee_bps integer,p_platform_fee_amount integer,p_processor_fee_amount integer,
  p_tax_amount integer,p_net_amount integer,p_currency text,p_metadata jsonb,p_access_token_hash text default null
) returns jsonb language sql security definer set search_path = '' as $$
 select public.fulfill_provider_commerce_order_with_period(p_product_id,p_buyer_email,p_buyer_name,p_provider,p_provider_account_id,
  p_provider_checkout_id,p_provider_payment_id,p_provider_subscription_id,p_gross_amount,p_platform_fee_bps,p_platform_fee_amount,
  p_processor_fee_amount,p_tax_amount,p_net_amount,p_currency,p_metadata,p_access_token_hash,null::timestamptz,null::timestamptz);
$$;
revoke all on function public.fulfill_provider_commerce_order(uuid,text,text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.fulfill_provider_commerce_order(uuid,text,text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,text,jsonb,text) to service_role;

-- All financial and subscription transitions acquire the same subscription lock
-- before locking orders or grants. In particular, a refund cannot race a paid
-- renewal into reactivating an unfunded period.
create or replace function public.lock_commerce_order_subscription(
  p_provider text, p_payment text, p_account text
) returns void language plpgsql security definer set search_path = '' as $$
declare o public.commerce_orders%rowtype;
begin
  select * into o from public.commerce_orders
   where provider = trim(p_provider) and provider_payment_id = trim(p_payment)
     and (p_account is null or coalesce(provider_account_id,'') = p_account);
  if nullif(o.provider_subscription_id,'') is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      o.provider || ':' || coalesce(o.provider_account_id,'') || ':' || o.provider_subscription_id, 0));
  end if;
end;
$$;
revoke all on function public.lock_commerce_order_subscription(text,text,text) from public,anon,authenticated;
grant execute on function public.lock_commerce_order_subscription(text,text,text) to service_role;

-- Financial event metadata never chooses a grant. Only the stored, validated
-- funding relation (or the unchanged one-time/legacy purchase relation) does.
create or replace function public.commerce_order_funds_access(p_order_id uuid,p_grant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists (
  select 1 from public.commerce_access_grants g
  join public.commerce_orders o on o.id=p_order_id
  left join public.commerce_subscription_access s on s.access_grant_id=g.id
  where g.id=p_grant_id and g.product_id=o.product_id and g.creator_id=o.creator_id
    and lower(trim(g.buyer_email))=lower(trim(o.buyer_email))
    and (
      (s.id is null and g.order_id=o.id)
      or (s.id is not null and coalesce(s.funding_order_id,g.order_id)=o.id
        and s.provider=o.provider and s.provider_account_id=coalesce(o.provider_account_id,'')
        and s.provider_subscription_id=o.provider_subscription_id
        and s.product_id=o.product_id and s.creator_id=o.creator_id
        and lower(trim(s.buyer_email))=lower(trim(o.buyer_email)))
    )
 );
$$;
revoke all on function public.commerce_order_funds_access(uuid,uuid) from public,anon,authenticated;
grant execute on function public.commerce_order_funds_access(uuid,uuid) to service_role;

-- Bound payment-failure grace to the last paid period, and share the same
-- implementation between direct and guarded callers (including refunded orders).
create or replace function public.apply_commerce_subscription_lifecycle_funded(
  p_provider text,
  p_provider_account_id text,
  p_provider_subscription_id text,
  p_state text,
  p_provider_event_id text,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false,
  p_metadata jsonb default '{}'::jsonb,
  p_grace_days integer default 3,
  p_funding_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscription_row public.commerce_subscription_access%rowtype;
  paid_order public.commerce_orders%rowtype;
  durable_grant public.commerce_access_grants%rowtype;
  normalized_state text;
  funding_order public.commerce_orders%rowtype;
  funding_session public.commerce_payment_sessions%rowtype;
  root_order public.commerce_orders%rowtype;
  effective_funding_id uuid;
  incoming_funding_is_current boolean := false;
  newer_funding boolean := false;
  replacement_funding boolean := false;
  normalized_account text := coalesce(p_provider_account_id,'');
  effective_state text;
  effective_period_start timestamptz;
  effective_period_end timestamptz;
  effective_grace timestamptz;
  access_deadline timestamptz;
begin
  if coalesce(trim(p_provider), '') = ''
    or coalesce(trim(p_provider_subscription_id), '') = '' then
    raise exception 'Provider and subscription id are required';
  end if;
  if p_state is null or p_state not in ('active', 'renewed', 'cancel_at_period_end', 'past_due', 'expired', 'revoked') then
    raise exception 'Unsupported subscription lifecycle state';
  end if;
  if p_grace_days is null or p_grace_days < 0 or p_grace_days > 30 then
    raise exception 'Subscription grace period is invalid';
  end if;

  normalized_state := case
    when p_state = 'renewed' then 'active'
    else p_state
  end;

  -- Serialize first lifecycle events too: there may not be a row to lock yet.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_provider || ':' || coalesce(p_provider_account_id, '') || ':' || p_provider_subscription_id, 0
  ));

  select * into subscription_row from public.commerce_subscription_access
   where provider=p_provider and provider_account_id=normalized_account
     and provider_subscription_id=p_provider_subscription_id for update;
  effective_funding_id := subscription_row.funding_order_id;

  if p_funding_order_id is not null then
    if p_state <> 'renewed' or p_current_period_start is null
      or p_current_period_end is null or p_current_period_end <= p_current_period_start then
      raise exception 'A verified funding order requires a paid service period';
    end if;
    select * into funding_order from public.commerce_orders where id=p_funding_order_id for update;
    select * into funding_session from public.commerce_payment_sessions
      where id::text=funding_order.metadata->>'bento_session_id';
    if funding_order.id is null or funding_session.id is null
      or funding_order.provider <> p_provider
      or coalesce(funding_order.provider_account_id,'') <> normalized_account
      or funding_order.provider_subscription_id is distinct from p_provider_subscription_id
      or funding_order.product_id <> funding_session.product_id
      or funding_order.creator_id <> funding_session.creator_id
      or funding_order.provider <> funding_session.provider
      or lower(trim(funding_order.buyer_email)) <> lower(trim(funding_session.buyer_email))
      or funding_order.gross_amount <> funding_session.gross_amount
      or funding_order.currency <> funding_session.currency
      or not exists (select 1 from public.creator_payment_accounts a
        where a.id=funding_session.connection_id and a.creator_id=funding_order.creator_id
          and a.provider=funding_order.provider
          and coalesce(a.provider_account_id,'')=normalized_account)
      or (subscription_row.id is not null and (
        subscription_row.product_id <> funding_order.product_id
        or subscription_row.creator_id <> funding_order.creator_id
        or lower(trim(subscription_row.buyer_email)) <> lower(trim(funding_order.buyer_email)))) then
      raise exception 'Funding order does not match this subscription checkout';
    end if;
    if funding_order.subscription_period_end is not null and (
      funding_order.subscription_period_start is distinct from p_current_period_start
      or funding_order.subscription_period_end is distinct from p_current_period_end) then
      raise exception 'A paid order service period is immutable';
    end if;
    update public.commerce_orders set subscription_period_start=p_current_period_start,
      subscription_period_end=p_current_period_end where id=funding_order.id;
    if funding_order.status not in ('paid','partially_refunded')
      or funding_order.refunded_amount >= funding_order.gross_amount
      or funding_order.gross_amount <= 0 then
      return jsonb_build_object('applied',false,'reason','financial_access_revoked');
    end if;
    replacement_funding := funding_order.id is distinct from subscription_row.funding_order_id
      and subscription_row.status not in ('expired','revoked')
      and p_current_period_start = subscription_row.current_period_start
      and p_current_period_end = subscription_row.current_period_end
      and exists (select 1 from public.commerce_orders prior_funding
        where prior_funding.id=subscription_row.funding_order_id
          and (prior_funding.status not in ('paid','partially_refunded')
            or prior_funding.refunded_amount >= prior_funding.gross_amount));
    incoming_funding_is_current := subscription_row.current_period_end is null
      or p_current_period_end > subscription_row.current_period_end
      or replacement_funding
      or (subscription_row.funding_order_id is null and p_current_period_end=subscription_row.current_period_end);
    -- A repeated or older paid invoice is financial history, not a fresh
    -- subscription status transition. Preserve any later cancellation/grace.
    -- A verified replacement for financially invalid same-period funding is
    -- explicitly eligible above and may still recover the paid service period.
    if not incoming_funding_is_current and p_current_period_end<=subscription_row.current_period_end then
      return jsonb_build_object('applied',false,'reason','paid_period_already_registered');
    end if;
    newer_funding := incoming_funding_is_current
      and funding_order.id is distinct from subscription_row.funding_order_id
      and p_current_period_end > coalesce(subscription_row.current_period_end,'-infinity'::timestamptz);
    if incoming_funding_is_current then effective_funding_id := funding_order.id; end if;
  end if;

  select * into paid_order from public.commerce_orders
   where provider=p_provider and coalesce(provider_account_id,'')=normalized_account
     and provider_subscription_id=p_provider_subscription_id
     and status in ('paid','partially_refunded','refunded','disputed')
     and (effective_funding_id is null or id=effective_funding_id)
   order by paid_at desc nulls last, created_at desc, id desc limit 1;
  if paid_order.id is null then return jsonb_build_object('applied',false,'reason','paid_order_not_found'); end if;

  if subscription_row.id is not null
    and p_provider_event_id is not null
    and subscription_row.last_provider_event_id = p_provider_event_id then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_processed',
      'subscription_access_id', subscription_row.id
    );
  end if;

  if subscription_row.id is not null
    and normalized_state in ('expired', 'revoked')
    and p_current_period_end is not null
    and subscription_row.current_period_end is not null
    and p_current_period_end < subscription_row.current_period_end then
    return jsonb_build_object(
      'applied', false,
      'reason', 'stale_terminal_event',
      'subscription_access_id', subscription_row.id,
      'access_grant_id', subscription_row.access_grant_id,
      'status', subscription_row.status
    );
  end if;

  if subscription_row.access_grant_id is not null then
    select * into durable_grant
      from public.commerce_access_grants
     where id = subscription_row.access_grant_id
     for update;
  end if;

  if durable_grant.id is null then
    select grant_row.*
      into durable_grant
      from public.commerce_access_grants grant_row
      join public.commerce_orders order_row on order_row.id = grant_row.order_id
     where order_row.provider = p_provider
       and coalesce(order_row.provider_account_id, '') = coalesce(p_provider_account_id, '')
       and order_row.provider_subscription_id = p_provider_subscription_id
     order by grant_row.created_at asc
     limit 1
     for update of grant_row;
  end if;

  if durable_grant.id is not null then
    select * into root_order from public.commerce_orders where id=durable_grant.order_id;
    if durable_grant.product_id <> paid_order.product_id
      or durable_grant.creator_id <> paid_order.creator_id
      or lower(trim(durable_grant.buyer_email)) <> lower(trim(paid_order.buyer_email))
      or root_order.provider <> paid_order.provider
      or coalesce(root_order.provider_account_id,'') <> normalized_account
      or root_order.provider_subscription_id is distinct from p_provider_subscription_id
      or (p_funding_order_id is not null and (
        nullif(root_order.metadata->>'bento_session_id','') is null
        or root_order.metadata->>'bento_session_id' is distinct from funding_order.metadata->>'bento_session_id')) then
      raise exception 'Funding order does not match the original durable access grant';
    end if;
  end if;

  -- A refunded/disputed payment cannot restore access just because its provider
  -- still reports the subscription active. Terminal events still reconcile it.
  if normalized_state not in ('expired', 'revoked')
    and paid_order.status in ('refunded', 'disputed') then
    return jsonb_build_object('applied', false, 'reason', 'financial_access_revoked');
  end if;

  -- Activation, cancellation scheduling and payment-failure events are not proof
  -- of a new payment. Only a paid renewal for a newer period can recover access.
  if normalized_state not in ('expired', 'revoked')
    and (subscription_row.status in ('expired', 'revoked')
      or durable_grant.status in ('expired', 'revoked'))
    and not (
      p_state = 'renewed'
      and (newer_funding or replacement_funding)
      and p_current_period_end is not null
      and (p_current_period_end > coalesce(subscription_row.current_period_end, '-infinity'::timestamptz)
        or replacement_funding)
    ) then
    return jsonb_build_object('applied', false, 'reason', 'terminal_access_requires_payment');
  end if;

  effective_period_start := coalesce(p_current_period_start, subscription_row.current_period_start);
  effective_period_end := coalesce(p_current_period_end, subscription_row.current_period_end);

  -- The stored period represents the last paid period. Failed invoices often
  -- contain the next (unpaid) period, and ordinary status updates can precede
  -- their payment. Neither can advance the paid boundary.
  if normalized_state = 'past_due'
    or (subscription_row.current_period_end is not null
      and not incoming_funding_is_current
      and normalized_state in ('active', 'cancel_at_period_end')) then
    effective_period_start := subscription_row.current_period_start;
    effective_period_end := subscription_row.current_period_end;
  end if;

  -- Never let a delayed webhook shorten a newer paid billing period.
  if subscription_row.current_period_end is not null
    and effective_period_end is not null
    and effective_period_end < subscription_row.current_period_end
    and normalized_state in ('active', 'past_due', 'cancel_at_period_end') then
    effective_period_end := subscription_row.current_period_end;
    effective_period_start := subscription_row.current_period_start;
  end if;

  effective_state := normalized_state;
  effective_grace := null;
  access_deadline := null;

  if normalized_state = 'active' then
    if effective_period_end is not null then
      effective_grace := effective_period_end + make_interval(days => p_grace_days);
      access_deadline := effective_grace;
    end if;
  elsif normalized_state = 'cancel_at_period_end' then
    access_deadline := effective_period_end;
  elsif normalized_state = 'past_due' then
    -- Preserve an existing grace deadline across every retry. If the paid period
    -- has never been observed, anchor to the actual payment rather than now() or
    -- the failed event's unearned future period.
    effective_grace := coalesce(
      subscription_row.grace_expires_at,
      coalesce(subscription_row.current_period_end, paid_order.paid_at, paid_order.created_at)
        + make_interval(days => p_grace_days)
    );
    access_deadline := effective_grace;
    if access_deadline <= now() then
      effective_state := 'expired';
    end if;
  elsif normalized_state in ('expired', 'revoked') then
    access_deadline := now();
  end if;

  insert into public.commerce_subscription_access(
    provider,
    provider_account_id,
    provider_subscription_id,
    product_id,
    creator_id,
    buyer_email,
    access_grant_id,
    funding_order_id,
    status,
    current_period_start,
    current_period_end,
    grace_expires_at,
    cancel_at_period_end,
    last_provider_event_id,
    metadata
  ) values (
    p_provider,
    coalesce(p_provider_account_id, ''),
    p_provider_subscription_id,
    paid_order.product_id,
    paid_order.creator_id,
    lower(paid_order.buyer_email),
    durable_grant.id,
    effective_funding_id,
    effective_state,
    effective_period_start,
    effective_period_end,
    effective_grace,
    p_cancel_at_period_end or effective_state = 'cancel_at_period_end',
    p_provider_event_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (provider, provider_account_id, provider_subscription_id)
  do update set
    product_id = excluded.product_id,
    creator_id = excluded.creator_id,
    buyer_email = excluded.buyer_email,
    access_grant_id = coalesce(
      public.commerce_subscription_access.access_grant_id,
      excluded.access_grant_id
    ),
    funding_order_id = excluded.funding_order_id,
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    grace_expires_at = excluded.grace_expires_at,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_provider_event_id = excluded.last_provider_event_id,
    metadata = public.commerce_subscription_access.metadata || excluded.metadata
  returning * into subscription_row;

  if durable_grant.id is not null then
    if effective_state in ('expired', 'revoked') then
      update public.commerce_access_grants
         set status = case when effective_state = 'revoked'
           then 'revoked'::public.commerce_access_status
           else 'expired'::public.commerce_access_status
         end,
             expires_at = access_deadline
       where id = durable_grant.id;
    else
      update public.commerce_access_grants
         set status = 'active',
             dispute_suspended_at = case when newer_funding or replacement_funding then null else dispute_suspended_at end,
             expires_at = access_deadline
       where id = durable_grant.id;
    end if;
  end if;

  return jsonb_build_object(
    'applied', true,
    'subscription_access_id', subscription_row.id,
    'access_grant_id', subscription_row.access_grant_id,
    'funding_order_id', subscription_row.funding_order_id,
    'status', subscription_row.status,
    'access_deadline', access_deadline
  );
end;
$$;

revoke all on function public.apply_commerce_subscription_lifecycle_funded(
  text, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, integer, uuid
) from public, anon, authenticated;
grant execute on function public.apply_commerce_subscription_lifecycle_funded(
  text, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, integer, uuid
) to service_role;


-- Legacy paid workers call fulfillment and lifecycle separately. Resolve their
-- unique unregistered payment using stored checkout and durable-grant identity;
-- event metadata never selects the funding order. Ambiguity retains webhook retry.
create or replace function public.apply_commerce_subscription_lifecycle(
  p_provider text,p_provider_account_id text,p_provider_subscription_id text,p_state text,p_provider_event_id text,
  p_current_period_start timestamptz default null,p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false,p_metadata jsonb default '{}'::jsonb,p_grace_days integer default 3
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 existing_access public.commerce_subscription_access%rowtype;
 eligible_orders uuid[];
 funding_id uuid;
 paid_state text:=p_state;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  p_provider||':'||coalesce(p_provider_account_id,'')||':'||p_provider_subscription_id,0));
 select * into existing_access from public.commerce_subscription_access
  where provider=p_provider and provider_account_id=coalesce(p_provider_account_id,'')
    and provider_subscription_id=p_provider_subscription_id for update;
 if p_state='renewed' then
  if p_current_period_start is null or p_current_period_end is null
    or p_current_period_end<=p_current_period_start then
   raise exception 'A legacy paid renewal requires a complete verified service period';
  end if;
  if existing_access.current_period_end is not null and p_current_period_end<=existing_access.current_period_end
    and not (p_current_period_start=existing_access.current_period_start and p_current_period_end=existing_access.current_period_end
      and exists(select 1 from public.commerce_orders current_payment
        where current_payment.id=coalesce(existing_access.funding_order_id,
          (select order_id from public.commerce_access_grants where id=existing_access.access_grant_id))
         and (current_payment.status not in ('paid','partially_refunded') or current_payment.refunded_amount>=current_payment.gross_amount))) then
   return jsonb_build_object('applied',false,'reason','paid_period_already_registered');
  end if;
  if existing_access.current_period_end is null or p_current_period_end>=existing_access.current_period_end then
   select array_agg(o.id) into eligible_orders from public.commerce_orders o
   join public.commerce_payment_sessions checkout on checkout.id::text=o.metadata->>'bento_session_id'
   join public.creator_payment_accounts account on account.id=checkout.connection_id
   where o.provider=p_provider and coalesce(o.provider_account_id,'')=coalesce(p_provider_account_id,'')
    and o.provider_subscription_id=p_provider_subscription_id
    and o.status in ('paid','partially_refunded') and o.paid_at is not null
    and o.gross_amount>0 and o.refunded_amount<o.gross_amount
    and nullif(trim(o.provider_payment_id),'') is not null
    and o.subscription_period_start is null and o.subscription_period_end is null
    -- These correlations are emitted only by the old verified paid adapter paths.
    -- A subscription status snapshot alone cannot consume a stored payment.
    and case p_provider
      when 'stripe' then nullif(p_metadata->>'stripe_invoice_id','') is not null
        and o.metadata->>'stripe_invoice_id'=p_metadata->>'stripe_invoice_id'
      when 'dodo' then nullif(p_metadata->>'dodo_payment_id','') is not null
        and o.provider_payment_id=p_metadata->>'dodo_payment_id'
      when 'polar' then nullif(p_metadata->>'polar_order_id','') is not null
        and o.provider_payment_id=p_metadata->>'polar_order_id'
      when 'razorpay' then p_provider_event_id='payment:'||o.provider_payment_id||':paid'
      when 'paypal' then o.metadata->>'current_period_start' is not null
        and o.metadata->>'current_period_end' is not null
        and (o.metadata->>'current_period_start')::timestamptz=p_current_period_start
        and (o.metadata->>'current_period_end')::timestamptz=p_current_period_end
      when 'creem' then o.metadata->>'current_period_start' is not null
        and o.metadata->>'current_period_end' is not null
        and (o.metadata->>'current_period_start')::timestamptz=p_current_period_start
        and (o.metadata->>'current_period_end')::timestamptz=p_current_period_end
      else false end
    and checkout.provider=o.provider and checkout.creator_id=o.creator_id and checkout.product_id=o.product_id
    and lower(trim(checkout.buyer_email))=lower(trim(o.buyer_email))
    and checkout.gross_amount=o.gross_amount and checkout.currency=o.currency
    and account.creator_id=o.creator_id and account.provider=o.provider
    and coalesce(account.provider_account_id,'')=coalesce(p_provider_account_id,'')
    and (existing_access.id is null or (existing_access.product_id=o.product_id
      and existing_access.creator_id=o.creator_id and lower(trim(existing_access.buyer_email))=lower(trim(o.buyer_email))))
    and exists (select 1 from public.commerce_access_grants durable
      join public.commerce_orders original on original.id=durable.order_id
      where (existing_access.access_grant_id is null or durable.id=existing_access.access_grant_id)
       and durable.product_id=o.product_id and durable.creator_id=o.creator_id
       and lower(trim(durable.buyer_email))=lower(trim(o.buyer_email))
       and original.provider=o.provider and coalesce(original.provider_account_id,'')=coalesce(o.provider_account_id,'')
       and original.provider_subscription_id=o.provider_subscription_id
       and original.metadata->>'bento_session_id'=o.metadata->>'bento_session_id');
   if coalesce(cardinality(eligible_orders),0)<>1 then
    raise exception 'Legacy paid renewal requires one unambiguous unregistered checkout payment';
   end if;
   funding_id:=eligible_orders[1];
   paid_state:='renewed';
  end if;
 end if;
 return public.apply_commerce_subscription_lifecycle_funded(p_provider,p_provider_account_id,p_provider_subscription_id,
  paid_state,p_provider_event_id,p_current_period_start,p_current_period_end,p_cancel_at_period_end,p_metadata,p_grace_days,funding_id);
end;
$$;
revoke all on function public.apply_commerce_subscription_lifecycle(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer) from public,anon,authenticated;
grant execute on function public.apply_commerce_subscription_lifecycle(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer) to service_role;

-- Preserve the existing ten-argument API for workers deployed before funding.
create or replace function public.apply_commerce_subscription_lifecycle_guarded(
  p_provider text,p_provider_account_id text,p_provider_subscription_id text,p_state text,p_provider_event_id text,
  p_current_period_start timestamptz default null,p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false,p_metadata jsonb default '{}'::jsonb,p_grace_days integer default 3
) returns jsonb language sql security definer set search_path = '' as $$
 select public.apply_commerce_subscription_lifecycle(p_provider,p_provider_account_id,p_provider_subscription_id,
  p_state,p_provider_event_id,p_current_period_start,p_current_period_end,p_cancel_at_period_end,p_metadata,p_grace_days);
$$;
revoke all on function public.apply_commerce_subscription_lifecycle_guarded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer) from public,anon,authenticated;
grant execute on function public.apply_commerce_subscription_lifecycle_guarded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer) to service_role;

create or replace function public.apply_commerce_refund(
  p_provider text,
  p_provider_payment_id text,
  p_provider_account_id text,
  p_provider_event_id text,
  p_refund_amount integer,
  p_amount_is_cumulative boolean default true,
  p_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.commerce_orders%rowtype;
  inserted_event_id uuid;
  next_refunded_amount integer;
  applied_amount integer;
  next_status public.commerce_order_status;
begin
  if nullif(trim(p_provider), '') is null
    or nullif(trim(p_provider_payment_id), '') is null
    or length(trim(p_provider_event_id)) not between 3 and 240 then
    raise exception 'A provider, payment ID, and provider event ID are required';
  end if;
  if p_refund_amount is not null and p_refund_amount < 0 then
    raise exception 'Refund amount cannot be negative';
  end if;

  perform public.lock_commerce_order_subscription(p_provider,p_provider_payment_id,p_provider_account_id);

  select *
    into order_row
    from public.commerce_orders
    where provider = trim(p_provider)
      and provider_payment_id = trim(p_provider_payment_id)
      and (
        p_provider_account_id is null
        or provider_account_id = p_provider_account_id
      )
    for update;

  if order_row.id is null then
    return null;
  end if;

  insert into public.commerce_order_events(
    order_id,
    creator_id,
    provider,
    provider_event_id,
    event_type,
    amount,
    currency,
    metadata,
    occurred_at
  )
  values (
    order_row.id,
    order_row.creator_id,
    trim(p_provider),
    trim(p_provider_event_id),
    'refund_succeeded',
    p_refund_amount,
    order_row.currency,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, now())
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    return jsonb_build_object(
      'order_id', order_row.id,
      'already_processed', true,
      'refunded_amount', order_row.refunded_amount,
      'applied_amount', 0,
      'fully_refunded', order_row.status = 'refunded',
      'status', order_row.status
    );
  end if;

  next_refunded_amount := least(
    order_row.gross_amount,
    greatest(
      order_row.refunded_amount,
      case
        when p_refund_amount is null then order_row.gross_amount
        when p_amount_is_cumulative then p_refund_amount
        else order_row.refunded_amount + p_refund_amount
      end
    )
  );
  applied_amount := greatest(0, next_refunded_amount - order_row.refunded_amount);
  next_status := case
    when next_refunded_amount >= order_row.gross_amount then 'refunded'
    when next_refunded_amount > 0 then 'partially_refunded'
    else order_row.status
  end;

  update public.commerce_orders
    set refunded_amount = next_refunded_amount,
        status = next_status,
        updated_at = now()
    where id = order_row.id;

  if next_status = 'refunded' then
    update public.commerce_access_grants
      set status = 'revoked',
          updated_at = now()
      where public.commerce_order_funds_access(order_row.id,commerce_access_grants.id)
        and status = 'active';
  end if;

  return jsonb_build_object(
    'order_id', order_row.id,
    'already_processed', false,
    'refunded_amount', next_refunded_amount,
    'applied_amount', applied_amount,
    'fully_refunded', next_status = 'refunded',
    'status', next_status
  );
end;
$$;

revoke all on function public.apply_commerce_refund(
  text, text, text, text, integer, boolean, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_commerce_refund(
  text, text, text, text, integer, boolean, jsonb, timestamptz
) to service_role;


create or replace function public.apply_commerce_dispute(
  p_provider text,
  p_provider_payment_id text,
  p_provider_account_id text,
  p_provider_event_id text,
  p_dispute_id text,
  p_outcome text,
  p_disputed_amount integer default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.commerce_orders%rowtype;
  inserted_event_id uuid;
  normalized_provider text := trim(p_provider);
  normalized_outcome text := lower(trim(p_outcome));
  normalized_dispute_id text := nullif(trim(p_dispute_id), '');
  event_time timestamptz := coalesce(p_occurred_at, now());
  event_type text;
  next_status public.commerce_order_status;
  is_open boolean;
  is_favorable boolean;
  state_applied boolean := true;
  suspended_count integer := 0;
  restored_count integer := 0;
begin
  if nullif(normalized_provider, '') is null
    or nullif(trim(p_provider_payment_id), '') is null
    or length(trim(p_provider_event_id)) not between 3 and 240
    or normalized_dispute_id is null then
    raise exception 'A provider, payment ID, provider event ID, and dispute ID are required';
  end if;
  if normalized_outcome not in (
    'open',
    'under_review',
    'won',
    'lost',
    'canceled',
    'accepted',
    'expired'
  ) then
    raise exception 'Unsupported dispute outcome';
  end if;
  if p_disputed_amount is not null and p_disputed_amount < 0 then
    raise exception 'Disputed amount cannot be negative';
  end if;

  perform public.lock_commerce_order_subscription(p_provider,p_provider_payment_id,p_provider_account_id);

  select *
    into order_row
    from public.commerce_orders
    where provider = normalized_provider
      and provider_payment_id = trim(p_provider_payment_id)
      and (
        p_provider_account_id is null
        or provider_account_id = p_provider_account_id
      )
    for update;

  if order_row.id is null then
    return null;
  end if;

  is_open := normalized_outcome in ('open', 'under_review');
  is_favorable := normalized_outcome in ('won', 'canceled');
  event_type := case when is_open then 'dispute_opened' else 'dispute_resolved' end;

  insert into public.commerce_order_events(
    order_id,
    creator_id,
    provider,
    provider_event_id,
    event_type,
    amount,
    currency,
    metadata,
    occurred_at
  )
  values (
    order_row.id,
    order_row.creator_id,
    normalized_provider,
    trim(p_provider_event_id),
    event_type,
    p_disputed_amount,
    order_row.currency,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'dispute_id', normalized_dispute_id,
      'outcome', normalized_outcome,
      'reason', nullif(trim(p_reason), '')
    ),
    event_time
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    return jsonb_build_object(
      'order_id', order_row.id,
      'already_processed', true,
      'state_applied', false,
      'dispute_status', order_row.dispute_status,
      'status', order_row.status,
      'suspended_grants', 0,
      'restored_grants', 0
    );
  end if;

  -- Do not let a delayed opening event roll a resolved dispute backwards.
  if is_open
    and order_row.dispute_id = normalized_dispute_id
    and order_row.dispute_resolved_at is not null
    and event_time <= order_row.dispute_resolved_at then
    state_applied := false;
  elsif is_open then
    update public.commerce_orders
      set pre_dispute_status = case
            when dispute_id is distinct from normalized_dispute_id then
              case
                when status in ('paid', 'partially_refunded', 'refunded') then status
                else pre_dispute_status
              end
            else coalesce(
              pre_dispute_status,
              case when status <> 'disputed' then status end
            )
          end,
          status = 'disputed',
          dispute_id = normalized_dispute_id,
          dispute_status = normalized_outcome,
          disputed_amount = least(
            gross_amount,
            greatest(disputed_amount, coalesce(p_disputed_amount, gross_amount))
          ),
          dispute_reason = coalesce(nullif(trim(p_reason), ''), dispute_reason),
          dispute_opened_at = case
            when dispute_id is distinct from normalized_dispute_id
              then event_time
            else coalesce(dispute_opened_at, event_time)
          end,
          dispute_resolved_at = null,
          updated_at = now()
      where id = order_row.id;

    update public.commerce_access_grants
      set status = 'revoked',
          dispute_suspended_at = coalesce(dispute_suspended_at, event_time),
          updated_at = now()
      where public.commerce_order_funds_access(order_row.id,commerce_access_grants.id)
        and status = 'active';
    get diagnostics suspended_count = row_count;
  else
    next_status := case
      when is_favorable and order_row.refunded_amount >= order_row.gross_amount then 'refunded'
      when is_favorable and order_row.refunded_amount > 0 then 'partially_refunded'
      when is_favorable and order_row.pre_dispute_status in (
        'paid',
        'partially_refunded',
        'refunded'
      ) then order_row.pre_dispute_status
      when is_favorable then 'paid'
      else 'disputed'
    end;

    update public.commerce_orders
      set status = next_status,
          dispute_id = normalized_dispute_id,
          dispute_status = normalized_outcome,
          disputed_amount = least(
            gross_amount,
            greatest(disputed_amount, coalesce(p_disputed_amount, gross_amount))
          ),
          dispute_reason = coalesce(nullif(trim(p_reason), ''), dispute_reason),
          dispute_opened_at = coalesce(dispute_opened_at, event_time),
          dispute_resolved_at = event_time,
          pre_dispute_status = coalesce(
            pre_dispute_status,
            case when status <> 'disputed' then status end
          ),
          updated_at = now()
      where id = order_row.id;

    if is_favorable then
      update public.commerce_access_grants
        set status = case
              when expires_at is not null and expires_at <= now() then 'expired'::public.commerce_access_status
              else 'active'::public.commerce_access_status
            end,
            dispute_suspended_at = null,
            updated_at = now()
        where public.commerce_order_funds_access(order_row.id,commerce_access_grants.id)
          and dispute_suspended_at is not null;
      get diagnostics restored_count = row_count;
    else
      update public.commerce_access_grants
        set status = 'revoked',
            dispute_suspended_at = coalesce(dispute_suspended_at, event_time),
            updated_at = now()
        where public.commerce_order_funds_access(order_row.id,commerce_access_grants.id)
          and status = 'active';
      get diagnostics suspended_count = row_count;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', order_row.id,
    'already_processed', false,
    'state_applied', state_applied,
    'dispute_status', normalized_outcome,
    'status', case when state_applied then
      (select status from public.commerce_orders where id = order_row.id)
      else order_row.status
    end,
    'suspended_grants', suspended_count,
    'restored_grants', restored_count
  );
end;
$$;

revoke all on function public.apply_commerce_dispute(
  text, text, text, text, text, text, integer, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_commerce_dispute(
  text, text, text, text, text, text, integer, text, jsonb, timestamptz
) to service_role;


create or replace function public.apply_commerce_dispute_guarded(
  p_provider text,
  p_provider_payment_id text,
  p_provider_account_id text,
  p_provider_event_id text,
  p_dispute_id text,
  p_outcome text,
  p_disputed_amount integer default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.commerce_orders%rowtype;
  event_time timestamptz := coalesce(p_occurred_at, now());
  normalized_dispute_id text := nullif(trim(p_dispute_id), '');
  normalized_outcome text := lower(trim(p_outcome));
  is_open boolean;
  latest_dispute_time timestamptz;
begin
  if nullif(trim(p_provider), '') is null
    or nullif(trim(p_provider_payment_id), '') is null
    or length(trim(p_provider_event_id)) not between 3 and 240
    or normalized_dispute_id is null then
    raise exception 'A provider, payment ID, provider event ID, and dispute ID are required';
  end if;
  if normalized_outcome not in (
    'open',
    'under_review',
    'won',
    'lost',
    'canceled',
    'accepted',
    'expired'
  ) then
    raise exception 'Unsupported dispute outcome';
  end if;
  if p_disputed_amount is not null and p_disputed_amount < 0 then
    raise exception 'Disputed amount cannot be negative';
  end if;

  perform public.lock_commerce_order_subscription(p_provider,p_provider_payment_id,p_provider_account_id);

  select * into order_row
  from public.commerce_orders
  where provider = trim(p_provider)
    and provider_payment_id = trim(p_provider_payment_id)
    and (
      p_provider_account_id is null
      or provider_account_id = p_provider_account_id
    )
  for update;

  if order_row.id is null then
    return null;
  end if;

  is_open := normalized_outcome in ('open', 'under_review');
  latest_dispute_time := greatest(
    coalesce(order_row.dispute_opened_at, '-infinity'::timestamptz),
    coalesce(order_row.dispute_resolved_at, '-infinity'::timestamptz)
  );

  -- A resolution can affect only the dispute currently attached to the order.
  -- This deliberately favors keeping access suspended over restoring it from a
  -- stale or mismatched provider event.
  if not is_open
    and order_row.dispute_id is not null
    and order_row.dispute_id is distinct from normalized_dispute_id then
    return jsonb_build_object(
      'order_id', order_row.id,
      'already_processed', false,
      'state_applied', false,
      'dispute_status', order_row.dispute_status,
      'status', order_row.status,
      'suspended_grants', 0,
      'restored_grants', 0
    );
  end if;

  if event_time < latest_dispute_time
    or (
      not is_open
      and order_row.dispute_opened_at is not null
      and event_time < order_row.dispute_opened_at
    ) then
    return jsonb_build_object(
      'order_id', order_row.id,
      'already_processed', false,
      'state_applied', false,
      'dispute_status', order_row.dispute_status,
      'status', order_row.status,
      'suspended_grants', 0,
      'restored_grants', 0
    );
  end if;

  return public.apply_commerce_dispute(
    p_provider,
    p_provider_payment_id,
    p_provider_account_id,
    p_provider_event_id,
    p_dispute_id,
    p_outcome,
    p_disputed_amount,
    p_reason,
    p_metadata,
    p_occurred_at
  );
end;
$$;

revoke all on function public.apply_commerce_dispute_guarded(
  text, text, text, text, text, text, integer, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_commerce_dispute_guarded(
  text, text, text, text, text, text, integer, text, jsonb, timestamptz
) to service_role;


create or replace function public.guard_commerce_access_restoration()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.commerce_subscription_access%rowtype; financial_order public.commerce_orders%rowtype;
begin
 if new.status <> 'active' then return new; end if;
 if new.dispute_suspended_at is not null then new.status := 'revoked'; return new; end if;
 select * into s from public.commerce_subscription_access where access_grant_id=new.id;
 if s.id is null then return new; end if;
 select * into financial_order from public.commerce_orders where id=coalesce(s.funding_order_id,new.order_id);
 if financial_order.id is null or financial_order.status not in ('paid','partially_refunded')
   or financial_order.refunded_amount >= financial_order.gross_amount then
   new.status := 'revoked'; return new;
 end if;
 if s.status='revoked' then new.status := 'revoked';
 elsif s.status='expired' or (s.status='past_due' and coalesce(s.grace_expires_at,s.current_period_end)<=now()) then new.status:='expired'; end if;
 return new;
end;
$$;
revoke all on function public.guard_commerce_access_restoration() from public,anon,authenticated;
