alter table public.commerce_priority_dm_requests
  add column free_follow_up_limit integer not null default 0
    check (free_follow_up_limit between 0 and 100),
  add column follow_up_price_amount integer
    check (follow_up_price_amount between 1 and 100000000),
  add column follow_up_currency text
    check (follow_up_currency ~ '^[a-z]{3}$'),
  add column creator_last_read_at timestamptz,
  add column buyer_last_read_at timestamptz,
  add column last_message_at timestamptz,
  add column last_message_preview text
    check (last_message_preview is null or length(last_message_preview) <= 280);

create table public.commerce_priority_dm_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.commerce_priority_dm_requests(id) on delete cascade,
  sender text not null check (sender in ('buyer', 'creator')),
  body text not null check (length(body) between 1 and 10000),
  order_id uuid unique references public.commerce_orders(id) on delete restrict,
  notification_eligible boolean not null default true,
  created_at timestamptz not null default now()
);

create index commerce_priority_dm_messages_request_created_idx
  on public.commerce_priority_dm_messages(request_id, created_at);

create index commerce_priority_dm_requests_creator_activity_idx
  on public.commerce_priority_dm_requests(creator_id, last_message_at desc);

alter table public.commerce_priority_dm_messages enable row level security;
revoke all on public.commerce_priority_dm_messages from public, anon, authenticated;
grant select on public.commerce_priority_dm_messages to authenticated;
grant all on public.commerce_priority_dm_messages to service_role;
revoke update (creator_reply, replied_at) on public.commerce_priority_dm_requests from authenticated;

create policy commerce_priority_dm_messages_creator_select
  on public.commerce_priority_dm_messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.commerce_priority_dm_requests request
      where request.id = commerce_priority_dm_messages.request_id
        and auth.uid() = request.creator_id
    )
  );

update public.commerce_priority_dm_requests request
set
  free_follow_up_limit = 0,
  follow_up_price_amount = product.price_amount,
  follow_up_currency = product.currency
from public.commerce_products product
where product.id = request.product_id;

insert into public.commerce_priority_dm_messages(
  request_id,
  sender,
  body,
  order_id,
  notification_eligible,
  created_at
)
select
  request.id,
  'buyer',
  request.message,
  request.order_id,
  false,
  request.created_at
from public.commerce_priority_dm_requests request;

insert into public.commerce_priority_dm_messages(
  request_id,
  sender,
  body,
  notification_eligible,
  created_at
)
select
  request.id,
  'creator',
  request.creator_reply,
  false,
  coalesce(request.replied_at, request.updated_at)
from public.commerce_priority_dm_requests request
where request.creator_reply is not null;

update public.commerce_priority_dm_requests request
set
  last_message_at = case
    when request.creator_reply is not null
      then coalesce(request.replied_at, request.updated_at)
    else request.created_at
  end,
  last_message_preview = left(
    coalesce(request.creator_reply, request.message),
    280
  );

alter table public.commerce_priority_dm_requests
  alter column follow_up_price_amount set not null,
  alter column follow_up_currency set not null;

create or replace function public.append_priority_dm_message(
  p_request_id uuid,
  p_sender text,
  p_body text,
  p_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.commerce_priority_dm_requests%rowtype;
  order_row public.commerce_orders%rowtype;
  message_row public.commerce_priority_dm_messages%rowtype;
  normalized_body text := trim(coalesce(p_body, ''));
  free_used bigint;
begin
  select *
  into request_row
  from public.commerce_priority_dm_requests
  where id = p_request_id
  for update;

  if request_row.id is null then
    raise exception 'priority DM conversation not found';
  end if;

  if p_sender is null or p_sender not in ('buyer', 'creator') then
    raise exception 'invalid priority DM sender';
  end if;
  if length(normalized_body) not between 1 and 10000 then
    raise exception 'priority DM message must be between 1 and 10000 characters';
  end if;
  if p_sender = 'creator' and p_order_id is not null then
    raise exception 'creator messages cannot use an order';
  end if;

  if p_order_id is not null then
    select *
    into message_row
    from public.commerce_priority_dm_messages
    where request_id = request_row.id
      and order_id = p_order_id;

    if message_row.id is not null then
      return to_jsonb(message_row);
    end if;
  end if;

  -- Once a provider or mock order is paid and matches the immutable request
  -- snapshot, its message entitlement survives later closure/refund of the
  -- original conversation. The order-id uniqueness keeps retries idempotent.
  if p_sender = 'buyer'
    and p_order_id is not null
    and p_order_id <> request_row.order_id then
    select *
    into order_row
    from public.commerce_orders
    where id = p_order_id
    for update;

    if order_row.id is null
      or order_row.product_id <> request_row.product_id
      or order_row.creator_id <> request_row.creator_id
      or lower(trim(order_row.buyer_email)) <> lower(trim(request_row.buyer_email))
      or order_row.status not in ('paid', 'partially_refunded')
      or coalesce(order_row.metadata->>'commerce_intent', '') <> 'priority_dm_followup'
      or coalesce(order_row.metadata->>'priority_dm_request_id', '') <> p_request_id::text then
      raise exception 'paid follow-up order is not eligible';
    end if;
    if order_row.gross_amount <> request_row.follow_up_price_amount then
      raise exception 'paid follow-up amount does not match';
    end if;
    if lower(trim(order_row.currency)) <> request_row.follow_up_currency then
      raise exception 'paid follow-up currency does not match';
    end if;

    insert into public.commerce_priority_dm_messages(
      request_id,
      sender,
      body,
      order_id
    )
    values (
      request_row.id,
      p_sender,
      normalized_body,
      p_order_id
    )
    on conflict (order_id) do nothing
    returning * into message_row;

    if message_row.id is null then
      select *
      into message_row
      from public.commerce_priority_dm_messages
      where request_id = request_row.id
        and order_id = p_order_id;

      if message_row.id is null then
        raise exception 'priority DM order is already linked to another conversation';
      end if;

      return to_jsonb(message_row);
    end if;

    update public.commerce_priority_dm_requests
    set
      status = case when request_row.status = 'closed' then 'closed' else 'unread' end,
      last_message_at = message_row.created_at,
      last_message_preview = left(normalized_body, 280)
    where id = request_row.id;

    return to_jsonb(message_row);
  end if;

  select *
  into order_row
  from public.commerce_orders
  where id = request_row.order_id
  for update;

  if order_row.id is null
    or order_row.status not in ('paid', 'partially_refunded') then
    raise exception 'priority DM purchase is no longer eligible for replies';
  end if;
  if request_row.status = 'closed' then
    raise exception 'priority DM conversation is closed';
  end if;

  if p_sender = 'buyer' and p_order_id is null then
    select count(*) into free_used
    from public.commerce_priority_dm_messages
    where request_id = p_request_id and sender = 'buyer' and order_id is null;
    if free_used >= request_row.free_follow_up_limit then
      raise exception 'free follow-up limit reached';
    end if;
  end if;

  insert into public.commerce_priority_dm_messages(
    request_id,
    sender,
    body,
    order_id
  )
  values (
    request_row.id,
    p_sender,
    normalized_body,
    p_order_id
  )
  on conflict (order_id) do nothing
  returning * into message_row;

  if message_row.id is null then
    select *
    into message_row
    from public.commerce_priority_dm_messages
    where request_id = request_row.id
      and order_id = p_order_id;

    if message_row.id is null then
      raise exception 'priority DM order is already linked to another conversation';
    end if;

    return to_jsonb(message_row);
  end if;

  if p_sender = 'buyer' then
    update public.commerce_priority_dm_requests
    set
      status = 'unread',
      last_message_at = message_row.created_at,
      last_message_preview = left(normalized_body, 280)
    where id = request_row.id;
  else
    update public.commerce_priority_dm_requests
    set
      status = 'replied',
      creator_reply = normalized_body,
      replied_at = message_row.created_at,
      last_message_at = message_row.created_at,
      last_message_preview = left(normalized_body, 280)
    where id = request_row.id;
  end if;

  return to_jsonb(message_row);
end;
$$;

revoke all on function public.append_priority_dm_message(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.append_priority_dm_message(uuid, text, text, uuid)
  to service_role;

create or replace function public.list_missing_priority_dm_notifications(
  p_limit integer default 200
)
returns table(id uuid, request_id uuid, sender text)
language sql
stable
security definer
set search_path = ''
as $$
  select message.id, message.request_id, message.sender
  from public.commerce_priority_dm_messages message
  where message.notification_eligible
    and not exists (
    select 1
    from public.email_outbox outbox
    where outbox.event_key =
      'priority-dm-message:' || message.id::text || ':' ||
      case when message.sender = 'buyer' then 'creator' else 'buyer' end
  )
  order by message.created_at asc, message.id asc
  limit least(500, greatest(1, coalesce(p_limit, 200)));
$$;

revoke all on function public.list_missing_priority_dm_notifications(integer)
  from public, anon, authenticated;
grant execute on function public.list_missing_priority_dm_notifications(integer) to service_role;

-- Paid follow-ups are conversation entitlements, not new initial-product sales.

create or replace function public.commerce_count_paid_order()
returns trigger
language plpgsql
security definer
set search_path = public
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
  follow_up_request public.commerce_priority_dm_requests%rowtype;
  created_order public.commerce_orders%rowtype;
  is_priority_dm_followup boolean :=
    coalesce(p_metadata->>'commerce_intent', '') = 'priority_dm_followup';
begin
  select * into product
  from public.commerce_products
  where id = p_product_id
  for update;

  if product.id is null or product.status <> 'published' then
    raise exception 'This product is not available';
  end if;
  if not is_priority_dm_followup
    and product.inventory_limit is not null
    and product.sales_count >= product.inventory_limit then
    raise exception 'This product is sold out';
  end if;
  if p_gross_amount < 0 or p_net_amount < 0 or p_platform_fee_amount < 0
    or p_processor_fee_amount < 0 then
    raise exception 'Invalid order amounts';
  end if;
  if is_priority_dm_followup then
    select * into follow_up_request
    from public.commerce_priority_dm_requests request
    where request.id::text = coalesce(p_metadata->>'priority_dm_request_id', '')
      and request.product_id = product.id
      and request.creator_id = product.creator_id
      and lower(trim(request.buyer_email)) = lower(trim(p_buyer_email))
      and request.follow_up_price_amount = p_gross_amount
      and request.follow_up_currency = lower(trim(p_currency));

    if follow_up_request.id is null then
      raise exception 'Paid follow-up does not match conversation snapshot';
    end if;
  else
    if p_currency <> product.currency then
      raise exception 'Order currency does not match product';
    end if;
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
  if coalesce(p_metadata->>'commerce_intent', '') <> 'priority_dm_followup'
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
