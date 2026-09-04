-- Keep creator-store deletes, joins, and webhook lookups predictable as community,
-- checkout, download, and subscription data grows.

create index if not exists commerce_community_comments_moderated_by_idx
  on public.commerce_community_comments(moderated_by)
  where moderated_by is not null;

create index if not exists commerce_community_comments_parent_comment_id_idx
  on public.commerce_community_comments(parent_comment_id)
  where parent_comment_id is not null;

create index if not exists commerce_community_notifications_comment_id_idx
  on public.commerce_community_notifications(comment_id)
  where comment_id is not null;

create index if not exists commerce_community_notifications_creator_id_idx
  on public.commerce_community_notifications(creator_id);

create index if not exists commerce_community_notifications_post_id_idx
  on public.commerce_community_notifications(post_id)
  where post_id is not null;

create index if not exists commerce_community_notifications_product_id_idx
  on public.commerce_community_notifications(product_id);

create index if not exists commerce_community_posts_moderated_by_idx
  on public.commerce_community_posts(moderated_by)
  where moderated_by is not null;

create index if not exists commerce_download_events_product_id_idx
  on public.commerce_download_events(product_id);

create index if not exists commerce_payment_sessions_bump_product_id_idx
  on public.commerce_payment_sessions(bump_product_id)
  where bump_product_id is not null;

create index if not exists commerce_payment_sessions_discount_code_id_idx
  on public.commerce_payment_sessions(discount_code_id)
  where discount_code_id is not null;

create index if not exists commerce_subscription_access_access_grant_id_idx
  on public.commerce_subscription_access(access_grant_id);

create index if not exists commerce_subscription_access_product_id_idx
  on public.commerce_subscription_access(product_id);

-- auth.uid() is stable for the statement. Evaluating it once avoids a function call per row.
alter policy commerce_order_events_owner_read
  on public.commerce_order_events
  using ((select auth.uid()) = creator_id);

-- Dashboard lists stay intentionally bounded, but headline counts and money must
-- remain exact at any store size. Monetary totals are grouped by currency so USD
-- and INR are never silently added together.
create or replace function public.get_creator_commerce_dashboard_stats(p_creator_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with recognized_orders as (
    select *
    from public.commerce_orders
    where creator_id = p_creator_id
      and status in ('paid', 'partially_refunded', 'refunded')
  ),
  money_by_currency as (
    select
      currency,
      count(*)::bigint as orders,
      sum(greatest(0, gross_amount - refunded_amount))::bigint as revenue,
      sum(greatest(0, net_amount - refunded_amount))::bigint as net,
      sum(platform_fee_amount + processor_fee_amount)::bigint as fees
    from recognized_orders
    group by currency
  ),
  checkout_totals as (
    select
      count(*)::bigint as started,
      count(*) filter (where status = 'paid')::bigint as completed,
      count(*) filter (where status in ('failed', 'expired', 'canceled'))::bigint as failed,
      count(*) filter (where discount_amount > 0)::bigint as discounted,
      count(*) filter (where bump_amount > 0)::bigint as bumped
    from public.commerce_payment_sessions
    where creator_id = p_creator_id
  )
  select jsonb_build_object(
    'orders', (select count(*) from recognized_orders),
    'leads', (
      select count(*) from public.commerce_leads where creator_id = p_creator_id
    ),
    'audience', (
      select count(*) from public.audience_contacts where creator_id = p_creator_id
    ),
    'checkoutStarted', coalesce((select started from checkout_totals), 0),
    'checkoutCompleted', coalesce((select completed from checkout_totals), 0),
    'checkoutFailed', coalesce((select failed from checkout_totals), 0),
    'discountedCheckouts', coalesce((select discounted from checkout_totals), 0),
    'bumpCheckouts', coalesce((select bumped from checkout_totals), 0),
    'moneyByCurrency', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'currency', currency,
            'orders', orders,
            'revenue', revenue,
            'net', net,
            'fees', fees
          )
          order by currency
        )
        from money_by_currency
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.get_creator_commerce_dashboard_stats(uuid)
  from public, anon, authenticated;
grant execute on function public.get_creator_commerce_dashboard_stats(uuid)
  to service_role;

-- Claim webhook delivery before running side effects. A plain upsert does not
-- provide mutual exclusion: two workers can both write "pending" and fulfill
-- the same event concurrently. The short processing lease lets a later retry
-- recover an event when a worker terminates unexpectedly.
alter table public.commerce_webhook_events
  drop constraint if exists commerce_webhook_events_status_check;
alter table public.commerce_webhook_events
  add constraint commerce_webhook_events_status_check
  check (status in ('pending', 'processing', 'processed', 'failed'));

create or replace function public.claim_commerce_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
  current_status text;
begin
  if nullif(trim(p_provider), '') is null
    or nullif(trim(p_provider_event_id), '') is null
    or nullif(trim(p_event_type), '') is null then
    raise exception 'Provider, event ID, and event type are required';
  end if;

  insert into public.commerce_webhook_events(
    provider, provider_event_id, event_type, payload, status, attempts,
    error_message, processed_at
  ) values (
    trim(p_provider), trim(p_provider_event_id), trim(p_event_type),
    coalesce(p_payload, '{}'::jsonb), 'processing', 1, null, null
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into claimed_id;

  if claimed_id is not null then
    return 'claimed';
  end if;

  select status into current_status
  from public.commerce_webhook_events
  where provider = trim(p_provider)
    and provider_event_id = trim(p_provider_event_id);

  if current_status = 'processed' then
    return 'processed';
  end if;

  update public.commerce_webhook_events
  set event_type = trim(p_event_type),
      payload = coalesce(p_payload, '{}'::jsonb),
      status = 'processing',
      attempts = attempts + 1,
      error_message = null,
      processed_at = null
  where provider = trim(p_provider)
    and provider_event_id = trim(p_provider_event_id)
    and (
      status in ('pending', 'failed')
      or (status = 'processing' and updated_at < now() - interval '5 minutes')
    )
  returning id into claimed_id;

  if claimed_id is not null then
    return 'claimed';
  end if;
  return 'busy';
end;
$$;

revoke all on function public.claim_commerce_webhook_event(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_commerce_webhook_event(text, text, text, jsonb)
  to service_role;

-- Reserve finite inventory when a payable checkout session is created, rather
-- than waiting until after the buyer has paid. Product-row locks serialize
-- concurrent starts, while expired/terminal sessions release capacity without
-- requiring a cleanup job.
create or replace function public.guard_commerce_checkout_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.commerce_products%rowtype;
  reserved_count bigint;
  needs_primary_check boolean;
  needs_bump_check boolean;
  old_was_active boolean;
begin
  if new.status not in ('pending', 'approved') or new.expires_at <= now() then
    return new;
  end if;

  if new.bump_product_id is not null and new.bump_product_id = new.product_id then
    raise exception 'Order bump must be different from the primary product';
  end if;

  if tg_op = 'INSERT' then
    old_was_active := false;
    needs_primary_check := true;
    needs_bump_check := new.bump_product_id is not null;
  else
    old_was_active := old.status in ('pending', 'approved') and old.expires_at > now();
    needs_primary_check := not old_was_active
      or old.product_id is distinct from new.product_id;
    needs_bump_check := new.bump_product_id is not null
      and (
        not old_was_active
        or old.bump_product_id is distinct from new.bump_product_id
      );
  end if;

  -- Always acquire both possible product locks in UUID order so two checkouts
  -- with crossed primary/bump products cannot deadlock each other.
  perform 1
  from public.commerce_products
  where id in (new.product_id, new.bump_product_id)
  order by id
  for update;

  if needs_primary_check then
    select * into product_row
    from public.commerce_products
    where id = new.product_id;
    if product_row.id is null then
      raise exception 'Product not found';
    end if;
    if product_row.inventory_limit is not null then
      select count(*) into reserved_count
      from public.commerce_payment_sessions session_row
      where (
          session_row.product_id = new.product_id
          or session_row.bump_product_id = new.product_id
        )
        and session_row.id <> new.id
        and session_row.status in ('pending', 'approved')
        and session_row.expires_at > now();
      if product_row.sales_count + reserved_count >= product_row.inventory_limit then
        raise exception 'Product is sold out';
      end if;
    end if;
  end if;

  if needs_bump_check then
    select * into product_row
    from public.commerce_products
    where id = new.bump_product_id;
    if product_row.id is null or product_row.pricing_type <> 'one_time' then
      raise exception 'Order bump is no longer available';
    end if;
    if product_row.inventory_limit is not null then
      select count(*) into reserved_count
      from public.commerce_payment_sessions session_row
      where (
          session_row.product_id = new.bump_product_id
          or session_row.bump_product_id = new.bump_product_id
        )
        and session_row.id <> new.id
        and session_row.status in ('pending', 'approved')
        and session_row.expires_at > now();
      if product_row.sales_count + reserved_count >= product_row.inventory_limit then
        raise exception 'Order bump is sold out';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_commerce_checkout_inventory()
  from public, anon, authenticated;

drop trigger if exists commerce_payment_sessions_inventory_guard
  on public.commerce_payment_sessions;
create trigger commerce_payment_sessions_inventory_guard
  before insert or update of product_id, bump_product_id, status, expires_at
  on public.commerce_payment_sessions
  for each row execute function public.guard_commerce_checkout_inventory();

-- Order bumps are paid products too. The original growth trigger granted bump
-- access but only the primary order incremented sales_count, so bump inventory
-- could be oversold and its creator stats were understated. Validate while the
-- product row is locked, then count only an order-item insert that succeeded.
create or replace function public.validate_commerce_bump_order_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bump_product public.commerce_products%rowtype;
begin
  if new.item_role <> 'bump' then
    return new;
  end if;

  if new.product_id is null or new.quantity <> 1 then
    raise exception 'Order bump must reference one product';
  end if;

  select * into bump_product
  from public.commerce_products
  where id = new.product_id
  for update;

  -- Price, currency and publish state were already captured and validated when
  -- the checkout session was created. Requiring the product's *current* values
  -- here would reject a legitimately paid checkout when a creator edits or
  -- archives the bump while the buyer is completing payment. Only the product
  -- identity/type and inventory still need to be enforced at fulfillment.
  if bump_product.id is null
    or bump_product.pricing_type <> 'one_time' then
    raise exception 'Order bump is no longer available';
  end if;

  if bump_product.inventory_limit is not null
    and bump_product.sales_count >= bump_product.inventory_limit then
    raise exception 'Order bump is sold out';
  end if;

  return new;
end;
$$;

create or replace function public.count_commerce_bump_order_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.item_role = 'bump' then
    update public.commerce_products
    set sales_count = sales_count + new.quantity
    where id = new.product_id;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_commerce_bump_order_item()
  from public, anon, authenticated;
revoke all on function public.count_commerce_bump_order_item()
  from public, anon, authenticated;

-- Existing bump sales predate the counter trigger.
with historical_bump_sales as (
  select product_id, sum(quantity)::integer as quantity
  from public.commerce_order_items
  where item_role = 'bump'
    and product_id is not null
  group by product_id
)
update public.commerce_products products
set sales_count = products.sales_count + historical_bump_sales.quantity
from historical_bump_sales
where products.id = historical_bump_sales.product_id;

drop trigger if exists commerce_order_items_validate_bump
  on public.commerce_order_items;
create trigger commerce_order_items_validate_bump
  before insert on public.commerce_order_items
  for each row execute function public.validate_commerce_bump_order_item();

drop trigger if exists commerce_order_items_count_bump
  on public.commerce_order_items;
create trigger commerce_order_items_count_bump
  after insert on public.commerce_order_items
  for each row execute function public.count_commerce_bump_order_item();

-- Keep growth offers valid even when they are written by a privileged internal
-- path instead of the application form. Inactive legacy rows remain editable
-- so a creator can safely disable or repair them.
create or replace function public.commerce_validate_growth_relationships()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  primary_row public.commerce_products%rowtype;
  bump_row public.commerce_products%rowtype;
begin
  if tg_table_name = 'commerce_discount_codes' and new.product_id is not null then
    select * into primary_row
    from public.commerce_products
    where id = new.product_id;

    if primary_row.id is null or primary_row.creator_id <> new.creator_id then
      raise exception 'Discount product must belong to the creator';
    end if;
    if new.discount_type = 'fixed' and new.currency <> primary_row.currency then
      raise exception 'Fixed discount currency must match the product';
    end if;
    if new.is_active then
      if primary_row.pricing_type <> 'one_time' then
        raise exception 'Discounts require a one-time product';
      end if;
      if primary_row.status <> 'published'
        or (
          primary_row.inventory_limit is not null
          and primary_row.sales_count >= primary_row.inventory_limit
        ) then
        raise exception 'Discount product must be published and available';
      end if;
      if new.discount_type = 'percent' and new.discount_value >= 10000 then
        raise exception 'Discount must leave a positive checkout total';
      end if;
      if new.discount_type = 'fixed'
        and new.discount_value >= primary_row.price_amount then
        raise exception 'Discount must leave a positive checkout total';
      end if;
    end if;
  elsif tg_table_name = 'commerce_order_bumps' then
    select * into primary_row
    from public.commerce_products
    where id = new.primary_product_id;
    select * into bump_row
    from public.commerce_products
    where id = new.bump_product_id;

    if primary_row.id is null or bump_row.id is null
      or primary_row.creator_id <> new.creator_id
      or bump_row.creator_id <> new.creator_id then
      raise exception 'Order bump products must belong to the creator';
    end if;
    if primary_row.currency <> bump_row.currency then
      raise exception 'Order bump products must use the same currency';
    end if;
    if primary_row.pricing_type <> 'one_time'
      or bump_row.pricing_type <> 'one_time' then
      raise exception 'Order bumps require one-time products';
    end if;
    if new.is_active and (
      primary_row.status <> 'published'
      or bump_row.status <> 'published'
      or (
        primary_row.inventory_limit is not null
        and primary_row.sales_count >= primary_row.inventory_limit
      )
      or (
        bump_row.inventory_limit is not null
        and bump_row.sales_count >= bump_row.inventory_limit
      )
    ) then
      raise exception 'Order bump products must be published and available';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.commerce_validate_growth_relationships()
  from public, anon, authenticated;

drop trigger if exists commerce_discount_codes_validate_relationships
  on public.commerce_discount_codes;
create trigger commerce_discount_codes_validate_relationships
  before insert or update of creator_id, product_id, discount_type,
    discount_value, currency, is_active
  on public.commerce_discount_codes
  for each row execute function public.commerce_validate_growth_relationships();

drop trigger if exists commerce_order_bumps_validate_relationships
  on public.commerce_order_bumps;
create trigger commerce_order_bumps_validate_relationships
  before insert or update of creator_id, primary_product_id, bump_product_id, is_active
  on public.commerce_order_bumps
  for each row execute function public.commerce_validate_growth_relationships();

-- A provider can reject checkout after the discount has been reserved. Release
-- that reservation as soon as the session reaches a terminal unpaid state so a
-- failed checkout cannot block a limited-use code until the two-hour timeout.
create or replace function public.release_terminal_commerce_discount_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('failed', 'expired', 'canceled')
    and old.status is distinct from new.status then
    update public.commerce_discount_redemptions
    set status = 'released'
    where payment_session_id = new.id
      and status = 'reserved';
  end if;
  return new;
end;
$$;

revoke all on function public.release_terminal_commerce_discount_reservation()
  from public, anon, authenticated;

drop trigger if exists commerce_payment_sessions_release_discount
  on public.commerce_payment_sessions;
create trigger commerce_payment_sessions_release_discount
  after update of status on public.commerce_payment_sessions
  for each row
  when (old.status is distinct from new.status)
  execute function public.release_terminal_commerce_discount_reservation();

-- Product deletion must be one transaction. The former application sequence
-- removed Bento blocks before the final product delete, allowing a concurrent
-- order to preserve the product while its card had already disappeared.
create or replace function public.delete_unused_commerce_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  product_row public.commerce_products%rowtype;
  removed_blocks integer := 0;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  select * into product_row
  from public.commerce_products
  where id = p_product_id
    and creator_id = caller_id
  for update;

  if product_row.id is null then
    raise exception 'Product not found';
  end if;

  delete from public.blocks
  where user_id = caller_id
    and type = 'commerce'
    and content->>'productId' = product_row.id::text;
  get diagnostics removed_blocks = row_count;

  if exists (
    select 1
    from public.commerce_orders
    where product_id = product_row.id
      and creator_id = caller_id
  ) or exists (
    -- A payment may be in flight before an order exists. Preserve the product
    -- row so a verified provider webhook can still fulfill that checkout.
    select 1
    from public.commerce_payment_sessions
    where (
        product_id = product_row.id
        or bump_product_id = product_row.id
      )
      and creator_id = caller_id
      and status in ('pending', 'approved')
  ) or exists (
    -- Bump purchases are financial history too. Their product reference lives
    -- on the order item rather than the order's primary product column.
    select 1
    from public.commerce_order_items
    where product_id = product_row.id
  ) then
    update public.commerce_products
    set status = 'archived',
        published_at = null
    where id = product_row.id;
    return jsonb_build_object(
      'deleted', false,
      'archived', true,
      'removedBlocks', removed_blocks
    );
  end if;

  delete from public.commerce_products
  where id = product_row.id
    and creator_id = caller_id;

  return jsonb_build_object(
    'deleted', true,
    'archived', false,
    'removedBlocks', removed_blocks
  );
end;
$$;

revoke all on function public.delete_unused_commerce_product(uuid)
  from public, anon;
grant execute on function public.delete_unused_commerce_product(uuid)
  to authenticated;

-- Provider webhooks must fulfill the immutable checkout snapshot, not whatever
-- price/currency happens to be on the product by the time the buyer pays. This
-- also prevents a forged webhook handler call from supplying amounts that were
-- never stored in Bento's own payment session.
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
  created_new_order boolean := false;
  metadata_session_id text := coalesce(p_metadata->>'bento_session_id', '');
begin
  if nullif(trim(p_provider), '') is null
    or nullif(trim(p_provider_payment_id), '') is null
    or nullif(trim(p_buyer_email), '') is null then
    raise exception 'Missing provider payment details';
  end if;

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
      provider_checkout_id = p_provider_checkout_id
      or id::text = p_provider_checkout_id
      or (metadata_session_id <> '' and id::text = metadata_session_id)
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
    or account_row.provider_account_id <> p_provider_account_id then
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
  if product_row.inventory_limit is not null
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
    nullif(trim(p_buyer_name), ''), 'paid', lower(trim(p_provider)),
    p_provider_account_id, p_provider_checkout_id, trim(p_provider_payment_id),
    nullif(trim(p_provider_subscription_id), ''), p_gross_amount,
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

  if created_new_order and p_access_token_hash is not null then
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

-- A subscription renewal and a dispute resolution can arrive in either order.
-- Never let either webhook reactivate access while the other lifecycle says the
-- grant must remain suspended or terminal.
create or replace function public.guard_commerce_access_restoration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscription_row public.commerce_subscription_access%rowtype;
begin
  if new.status <> 'active' then
    return new;
  end if;

  if new.dispute_suspended_at is not null then
    new.status := 'revoked';
    return new;
  end if;

  select * into subscription_row
  from public.commerce_subscription_access
  where access_grant_id = new.id;

  if subscription_row.id is null then
    return new;
  end if;

  if subscription_row.status = 'revoked' then
    new.status := 'revoked';
  elsif subscription_row.status = 'expired'
    or (
      subscription_row.status = 'past_due'
      and coalesce(
        subscription_row.grace_expires_at,
        subscription_row.current_period_end
      ) <= now()
    ) then
    new.status := 'expired';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_commerce_access_restoration
  on public.commerce_access_grants;
create trigger trg_guard_commerce_access_restoration
before insert or update of status, dispute_suspended_at
on public.commerce_access_grants
for each row execute function public.guard_commerce_access_restoration();

-- The original dispute RPC guarded a delayed opening event only when it
-- referred to the same dispute. A late event for an older dispute could still
-- replace a newer dispute, and a resolution for the wrong dispute could restore
-- access. Keep that compatibility function intact and put a strict ordering and
-- identity gate in front of it.
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

-- The original subscription lifecycle looked up only an order whose current
-- status was exactly "paid". Refund and dispute transitions legitimately
-- change that status, but must not make later renewals/cancellations disappear.
-- Delegate the normal case to the established function and repair the
-- recognized-order case when its narrow lookup cannot find the purchase.
create or replace function public.apply_commerce_subscription_lifecycle_guarded(
  p_provider text,
  p_provider_account_id text,
  p_provider_subscription_id text,
  p_state text,
  p_provider_event_id text,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false,
  p_metadata jsonb default '{}'::jsonb,
  p_grace_days integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_result jsonb;
  subscription_row public.commerce_subscription_access%rowtype;
  recognized_order public.commerce_orders%rowtype;
  durable_grant public.commerce_access_grants%rowtype;
  normalized_state text;
  effective_state text;
  effective_period_start timestamptz;
  effective_period_end timestamptz;
  effective_grace timestamptz;
  access_deadline timestamptz;
begin
  base_result := public.apply_commerce_subscription_lifecycle(
    p_provider,
    p_provider_account_id,
    p_provider_subscription_id,
    p_state,
    p_provider_event_id,
    p_current_period_start,
    p_current_period_end,
    p_cancel_at_period_end,
    p_metadata,
    p_grace_days
  );

  if coalesce(base_result->>'reason', '') <> 'paid_order_not_found' then
    return base_result;
  end if;

  normalized_state := case when p_state = 'renewed' then 'active' else p_state end;

  select * into recognized_order
  from public.commerce_orders
  where provider = p_provider
    and coalesce(provider_account_id, '') = coalesce(p_provider_account_id, '')
    and provider_subscription_id = p_provider_subscription_id
    and status in ('paid', 'partially_refunded', 'refunded', 'disputed')
  order by paid_at desc nulls last, created_at desc
  limit 1;

  if recognized_order.id is null then
    return base_result;
  end if;

  select * into subscription_row
  from public.commerce_subscription_access
  where provider = p_provider
    and provider_account_id = coalesce(p_provider_account_id, '')
    and provider_subscription_id = p_provider_subscription_id
  for update;

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
    select grant_row.* into durable_grant
    from public.commerce_access_grants grant_row
    join public.commerce_orders order_row on order_row.id = grant_row.order_id
    where order_row.provider = p_provider
      and coalesce(order_row.provider_account_id, '') = coalesce(p_provider_account_id, '')
      and order_row.provider_subscription_id = p_provider_subscription_id
    order by grant_row.created_at asc
    limit 1
    for update of grant_row;
  end if;

  effective_period_start := coalesce(
    p_current_period_start,
    subscription_row.current_period_start
  );
  effective_period_end := coalesce(
    p_current_period_end,
    subscription_row.current_period_end
  );

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
    effective_grace := greatest(coalesce(effective_period_end, now()), now())
      + make_interval(days => p_grace_days);
    access_deadline := effective_grace;
  elsif normalized_state in ('expired', 'revoked') then
    access_deadline := now();
  end if;

  insert into public.commerce_subscription_access(
    provider, provider_account_id, provider_subscription_id, product_id,
    creator_id, buyer_email, access_grant_id, status, current_period_start,
    current_period_end, grace_expires_at, cancel_at_period_end,
    last_provider_event_id, metadata
  ) values (
    p_provider, coalesce(p_provider_account_id, ''), p_provider_subscription_id,
    recognized_order.product_id, recognized_order.creator_id,
    lower(recognized_order.buyer_email), durable_grant.id, effective_state,
    effective_period_start, effective_period_end, effective_grace,
    p_cancel_at_period_end or effective_state = 'cancel_at_period_end',
    p_provider_event_id, coalesce(p_metadata, '{}'::jsonb)
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
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    grace_expires_at = excluded.grace_expires_at,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_provider_event_id = excluded.last_provider_event_id,
    metadata = public.commerce_subscription_access.metadata || excluded.metadata
  returning * into subscription_row;

  if durable_grant.id is not null then
    update public.commerce_access_grants
    set status = case
          when effective_state = 'revoked' then 'revoked'::public.commerce_access_status
          when effective_state = 'expired' then 'expired'::public.commerce_access_status
          else 'active'::public.commerce_access_status
        end,
        expires_at = access_deadline
    where id = durable_grant.id;
  end if;

  return jsonb_build_object(
    'applied', true,
    'subscription_access_id', subscription_row.id,
    'access_grant_id', subscription_row.access_grant_id,
    'status', subscription_row.status,
    'access_deadline', access_deadline
  );
end;
$$;

revoke all on function public.apply_commerce_subscription_lifecycle_guarded(
  text, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.apply_commerce_subscription_lifecycle_guarded(
  text, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, integer
) to service_role;

-- Repeated free claims must not create duplicate paid-looking orders, consume
-- inventory twice, or spam creator/buyer receipts. The stable checkout key is
-- generated server-side from product + normalized email. A repeat claim gets a
-- fresh short-lived capability for the original active grant.
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
  grant_row public.commerce_access_grants%rowtype;
  customer_row public.commerce_customers%rowtype;
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
    return fulfillment || jsonb_build_object('created_new_order', true);
  end if;

  if order_row.product_id <> product_row.id
    or lower(trim(order_row.buyer_email)) <> normalized_email then
    raise exception 'Free claim identity does not match the original order';
  end if;

  select * into grant_row
  from public.commerce_access_grants
  where order_id = order_row.id
    and product_id = product_row.id
    and lower(trim(buyer_email)) = normalized_email
    and status = 'active'
    and (expires_at is null or expires_at > now())
  order by created_at asc
  limit 1;

  if grant_row.id is null then
    raise exception 'This free access grant is no longer active';
  end if;

  insert into public.commerce_customers(email, name)
  values (
    normalized_email,
    nullif(left(trim(coalesce(p_buyer_name, '')), 120), '')
  )
  on conflict (email_normalized) do update
    set name = coalesce(nullif(excluded.name, ''), public.commerce_customers.name),
        updated_at = now()
  returning * into customer_row;

  insert into public.commerce_customer_access_tokens(
    customer_id, grant_id, token_hash, expires_at
  ) values (
    customer_row.id,
    grant_row.id,
    p_access_token_hash,
    now() + interval '30 minutes'
  );

  return jsonb_build_object(
    'order_id', order_row.id,
    'product_id', product_row.id,
    'creator_id', product_row.creator_id,
    'created_new_order', false
  );
end;
$$;

revoke all on function public.claim_free_commerce_offer(
  uuid, text, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.claim_free_commerce_offer(
  uuid, text, text, text, jsonb, text
) to service_role;

-- Keep every existing attendee on the same canonical webinar schedule as the
-- product. This runs in the product update transaction, so a reschedule can
-- never leave the product and its buyer delivery records disagreeing.
create or replace function public.sync_webinar_registrations_from_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_start timestamptz;
  duration_minutes integer;
  schedule_changed boolean;
  replay_changed boolean;
begin
  if new.kind::text <> 'webinar'
    or nullif(new.settings ->> 'startsAt', '') is null then
    return new;
  end if;

  event_start := (new.settings ->> 'startsAt')::timestamptz;
  duration_minutes := (new.settings ->> 'durationMinutes')::integer;
  if duration_minutes < 10 or duration_minutes > 480 then
    raise exception 'Webinar duration must be between 10 and 480 minutes';
  end if;

  schedule_changed :=
    old.settings ->> 'startsAt' is distinct from new.settings ->> 'startsAt'
    or old.settings ->> 'durationMinutes' is distinct from new.settings ->> 'durationMinutes'
    or old.settings ->> 'timezone' is distinct from new.settings ->> 'timezone';
  replay_changed :=
    old.settings ->> 'replayUrl' is distinct from new.settings ->> 'replayUrl';

  update public.commerce_webinar_registrations
  set starts_at = event_start,
      ends_at = event_start + make_interval(mins => duration_minutes),
      timezone = coalesce(nullif(new.settings ->> 'timezone', ''), 'UTC'),
      join_url = nullif(new.settings ->> 'joinUrl', ''),
      replay_url = nullif(new.settings ->> 'replayUrl', ''),
      reminder_24h_sent_at = case
        when schedule_changed then null else reminder_24h_sent_at
      end,
      reminder_1h_sent_at = case
        when schedule_changed then null else reminder_1h_sent_at
      end,
      replay_ready_notified_at = case
        when replay_changed then null else replay_ready_notified_at
      end,
      updated_at = now()
  where product_id = new.id
    and creator_id = new.creator_id
    and status <> 'canceled';

  return new;
end;
$$;

revoke all on function public.sync_webinar_registrations_from_product()
  from public, anon, authenticated;

drop trigger if exists commerce_products_sync_webinar_registrations
  on public.commerce_products;
create trigger commerce_products_sync_webinar_registrations
  after update of settings on public.commerce_products
  for each row
  when (old.settings is distinct from new.settings)
  execute function public.sync_webinar_registrations_from_product();

comment on table public.commerce_webinar_registrations is
  'Per-buyer webinar delivery state synchronized atomically with creator schedule and link updates.';
