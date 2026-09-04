-- Durable, idempotent reminder state for paid coaching sessions.

alter table public.commerce_bookings
  add column if not exists reminder_24h_sent_at timestamptz,
  add column if not exists reminder_1h_sent_at timestamptz;

create index if not exists commerce_bookings_reminders_idx
  on public.commerce_bookings(starts_at)
  where status = 'confirmed'
    and (reminder_24h_sent_at is null or reminder_1h_sent_at is null);

comment on column public.commerce_bookings.reminder_24h_sent_at is
  'Time the idempotent 24-hour customer reminder was queued.';
comment on column public.commerce_bookings.reminder_1h_sent_at is
  'Time the idempotent 1-hour customer reminder was queued.';
