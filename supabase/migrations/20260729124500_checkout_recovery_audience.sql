-- Checkout recovery and drop-off visibility.
--
-- Payment-session events intentionally copy only non-sensitive provider and
-- amount fields. Session metadata can contain encrypted access material and
-- must never be replicated into creator-readable Audience rows.

create index commerce_payment_sessions_pending_expiry_idx
  on public.commerce_payment_sessions(expires_at)
  where status = 'pending';

create or replace function public.commerce_sync_payment_session_to_audience()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_row_id uuid;
  event_time timestamptz := coalesce(new.updated_at, new.created_at, now());
begin
  if new.creator_id is null
    or new.buyer_email is null
    or trim(new.buyer_email) = ''
    or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return new;
  end if;

  contact_row_id := public.commerce_upsert_audience_contact(
    new.creator_id,
    new.buyer_email,
    new.buyer_name,
    'checkout',
    event_time
  );

  insert into public.audience_events(
    creator_id,
    contact_id,
    event_type,
    source_type,
    source_id,
    product_id,
    amount,
    currency,
    dedupe_key,
    metadata,
    occurred_at
  )
  values (
    new.creator_id,
    contact_row_id,
    'checkout_' || new.status,
    'commerce_payment_session',
    new.id,
    new.product_id,
    new.gross_amount,
    new.currency,
    'checkout:' || new.id::text || ':' || new.status,
    jsonb_build_object(
      'provider', new.provider,
      'recording_addon_selected', new.recording_addon_selected
    ),
    event_time
  )
  on conflict (creator_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.commerce_sync_payment_session_to_audience()
  from public, anon, authenticated;
grant execute on function public.commerce_sync_payment_session_to_audience()
  to service_role;

drop trigger if exists commerce_payment_sessions_sync_audience
  on public.commerce_payment_sessions;
create trigger commerce_payment_sessions_sync_audience
  after insert or update of status on public.commerce_payment_sessions
  for each row execute function public.commerce_sync_payment_session_to_audience();

-- Expire old pending sessions before backfilling so historical drop-off is
-- represented accurately. The Worker repeats this transition every minute.
update public.commerce_payment_sessions
set status = 'expired'
where status = 'pending'
  and expires_at <= now();

insert into public.audience_events(
  creator_id,
  contact_id,
  event_type,
  source_type,
  source_id,
  product_id,
  amount,
  currency,
  dedupe_key,
  metadata,
  occurred_at
)
select
  session.creator_id,
  public.commerce_upsert_audience_contact(
    session.creator_id,
    session.buyer_email,
    session.buyer_name,
    'checkout',
    coalesce(session.updated_at, session.created_at)
  ),
  'checkout_' || session.status,
  'commerce_payment_session',
  session.id,
  session.product_id,
  session.gross_amount,
  session.currency,
  'checkout:' || session.id::text || ':' || session.status,
  jsonb_build_object(
    'provider', session.provider,
    'recording_addon_selected', session.recording_addon_selected
  ),
  coalesce(session.updated_at, session.created_at)
from public.commerce_payment_sessions session
where trim(session.buyer_email) <> ''
on conflict (creator_id, dedupe_key) do nothing;
