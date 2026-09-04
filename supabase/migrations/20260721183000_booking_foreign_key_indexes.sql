-- Cover booking foreign keys used by account deletion and connection cleanup.
create index if not exists booking_calendar_oauth_states_user_idx
  on public.booking_calendar_oauth_states(user_id);
create index if not exists booking_fathom_oauth_states_user_idx
  on public.booking_fathom_oauth_states(user_id);
create index if not exists commerce_bookings_calendar_connection_idx
  on public.commerce_bookings(calendar_connection_id)
  where calendar_connection_id is not null;
create index if not exists commerce_bookings_fathom_connection_idx
  on public.commerce_bookings(fathom_connection_id)
  where fathom_connection_id is not null;
