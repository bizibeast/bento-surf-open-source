-- Provider-neutral, idempotent dispute state.
--
-- A verified dispute temporarily suspends only the access grants attached to
-- the affected purchase. If the creator wins (or the buyer cancels), only
-- grants suspended by that dispute are restored. Adverse resolutions keep
-- access revoked while preserving the original order and receipt history.

alter table public.commerce_orders
  add column dispute_id text,
  add column dispute_status text
    check (
      dispute_status is null
      or dispute_status in (
        'open',
        'under_review',
        'won',
        'lost',
        'canceled',
        'accepted',
        'expired'
      )
    ),
  add column disputed_amount integer not null default 0
    check (disputed_amount >= 0),
  add column dispute_reason text,
  add column dispute_opened_at timestamptz,
  add column dispute_resolved_at timestamptz,
  add column pre_dispute_status public.commerce_order_status;

alter table public.commerce_access_grants
  add column dispute_suspended_at timestamptz;

create index commerce_orders_open_dispute_idx
  on public.commerce_orders(creator_id, dispute_opened_at desc)
  where status = 'disputed';

-- Restoring a successfully defended dispute must not count the same sale a
-- second time.
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

  if should_count then
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

revoke all on function public.commerce_count_paid_order() from public;

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
set search_path = public
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
      where order_id = order_row.id
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
              when expires_at is not null and expires_at <= now() then 'expired'
              else 'active'
            end,
            dispute_suspended_at = null,
            updated_at = now()
        where order_id = order_row.id
          and dispute_suspended_at is not null;
      get diagnostics restored_count = row_count;
    else
      update public.commerce_access_grants
        set status = 'revoked',
            dispute_suspended_at = coalesce(dispute_suspended_at, event_time),
            updated_at = now()
        where order_id = order_row.id
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

comment on column public.commerce_orders.dispute_status is
  'Normalized status from the latest signature-verified provider dispute event.';
comment on column public.commerce_access_grants.dispute_suspended_at is
  'Set only when a verified dispute suspends an otherwise active purchase grant.';
comment on function public.apply_commerce_dispute(
  text, text, text, text, text, text, integer, text, jsonb, timestamptz
) is
  'Atomically records a verified dispute, prevents stale event rollback, and suspends or safely restores purchased access.';
