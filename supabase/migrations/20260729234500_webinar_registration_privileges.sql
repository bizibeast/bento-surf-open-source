-- Supabase projects can define default privileges for authenticated on new
-- public tables. Reset this table explicitly so immutable event details remain
-- service-role controlled.
revoke all on public.commerce_webinar_registrations from authenticated;
grant select on public.commerce_webinar_registrations to authenticated;
grant update (status, attended_at)
  on public.commerce_webinar_registrations to authenticated;
