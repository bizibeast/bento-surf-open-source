-- Anonymous visitors never update profiles. The authenticated profile update
-- handler verifies Store entitlement, and RLS enforces workspace membership.
revoke update on public.profiles from anon;
grant update (store_page_enabled) on public.profiles to authenticated;
