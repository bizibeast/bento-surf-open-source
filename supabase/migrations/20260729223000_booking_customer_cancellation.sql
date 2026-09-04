-- Customer cancellation audit and retryable Google Calendar cleanup.

alter table public.commerce_bookings
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by text,
  add column if not exists calendar_cancel_status text not null default 'not_required',
  add column if not exists calendar_cancel_error text;

alter table public.commerce_bookings
  drop constraint if exists commerce_bookings_canceled_by_check;
alter table public.commerce_bookings
  add constraint commerce_bookings_canceled_by_check
  check (canceled_by is null or canceled_by in ('customer', 'creator', 'system'));

alter table public.commerce_bookings
  drop constraint if exists commerce_bookings_calendar_cancel_status_check;
alter table public.commerce_bookings
  add constraint commerce_bookings_calendar_cancel_status_check
  check (calendar_cancel_status in ('not_required', 'pending', 'succeeded'));

create index if not exists commerce_bookings_calendar_cancel_pending_idx
  on public.commerce_bookings(updated_at)
  where status = 'canceled' and calendar_cancel_status = 'pending';

comment on column public.commerce_bookings.calendar_cancel_status is
  'Tracks deletion of a canceled booking from the connected Google Calendar.';
