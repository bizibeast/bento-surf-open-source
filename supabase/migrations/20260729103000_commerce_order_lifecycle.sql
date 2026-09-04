-- Reliable provider-neutral commerce order lifecycle.
--
-- Refund webhooks previously updated commerce_orders and access grants in
-- separate statements. That allowed concurrent partial refunds to race and
-- represented partial refunds as paid orders. This migration makes the
-- transition atomic and records every accepted provider event for receipts,
-- support, and audit history.

create table public.commerce_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete restrict,
  provider text not null check (length(provider) between 1 and 40),
  provider_event_id text not null check (length(provider_event_id) between 3 and 240),
  event_type text not null check (
    event_type in (
      'refund_succeeded',
      'dispute_opened',
      'dispute_resolved',
      'payment_failed',
      'subscription_canceled'
    )
  ),
  amount integer check (amount is null or amount >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint commerce_order_events_provider_event_unique
    unique (provider, provider_event_id)
);

create index commerce_order_events_order_occurred_idx
  on public.commerce_order_events(order_id, occurred_at desc);
create index commerce_order_events_creator_occurred_idx
  on public.commerce_order_events(creator_id, occurred_at desc);

alter table public.commerce_order_events enable row level security;
revoke all on public.commerce_order_events from anon, authenticated;
grant select on public.commerce_order_events to authenticated;
grant all on public.commerce_order_events to service_role;

create policy commerce_order_events_owner_read
  on public.commerce_order_events for select
  to authenticated
  using (auth.uid() = creator_id);

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
set search_path = public
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
      where order_id = order_row.id
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

comment on table public.commerce_order_events is
  'Append-only, idempotent provider lifecycle events for creator commerce orders.';
comment on function public.apply_commerce_refund(
  text, text, text, text, integer, boolean, jsonb, timestamptz
) is
  'Atomically records a verified provider refund, updates cumulative order state, and revokes access only after a full refund.';
