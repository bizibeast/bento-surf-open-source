-- Persist the creator's complete blocked window so simultaneous booking
-- requests cannot bypass before/after buffers. One paid/free claim grants one
-- active booking at a time; canceled bookings remain historical and release
-- the grant for a future booking.

alter table public.commerce_bookings
  add column if not exists blocked_starts_at timestamptz,
  add column if not exists blocked_ends_at timestamptz;

update public.commerce_bookings
set
  blocked_starts_at = coalesce(blocked_starts_at, starts_at),
  blocked_ends_at = coalesce(blocked_ends_at, ends_at)
where blocked_starts_at is null or blocked_ends_at is null;

alter table public.commerce_bookings
  alter column blocked_starts_at set not null,
  alter column blocked_ends_at set not null;

alter table public.commerce_bookings
  drop constraint if exists commerce_bookings_blocked_time_check;
alter table public.commerce_bookings
  add constraint commerce_bookings_blocked_time_check
  check (
    blocked_starts_at <= starts_at
    and blocked_ends_at >= ends_at
    and blocked_ends_at > blocked_starts_at
  );

alter table public.commerce_bookings
  drop constraint if exists commerce_bookings_no_overlap;
alter table public.commerce_bookings
  add constraint commerce_bookings_no_overlap
  exclude using gist (
    creator_id with =,
    tstzrange(blocked_starts_at, blocked_ends_at, '[)') with &&
  ) where (status <> 'canceled');

create unique index if not exists commerce_bookings_one_active_order_idx
  on public.commerce_bookings(order_id)
  where order_id is not null and status <> 'canceled';

comment on column public.commerce_bookings.blocked_starts_at is
  'Start of the creator-reserved window including the configured pre-call buffer.';
comment on column public.commerce_bookings.blocked_ends_at is
  'End of the creator-reserved window including the configured post-call buffer.';
