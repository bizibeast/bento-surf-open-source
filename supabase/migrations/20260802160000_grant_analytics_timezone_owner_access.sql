-- Profile access is intentionally column-scoped. The analytics timezone was
-- added after the authenticated profile allowlist, so expose only this field
-- and continue relying on the owner read/update RLS policies for row access.
grant select (analytics_timezone)
  on public.profiles to authenticated;

grant update (analytics_timezone)
  on public.profiles to authenticated;

notify pgrst, 'reload schema';
