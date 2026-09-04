-- Trigger functions are invoked by PostgreSQL and must never be exposed as
-- callable SECURITY DEFINER RPCs to browser roles.
revoke all on function public.guard_commerce_access_restoration()
  from public, anon, authenticated;
