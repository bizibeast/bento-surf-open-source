
-- Lock search_path for trigger fn
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql security invoker set search_path = public
as $$ begin new.updated_at = now(); return new; end $$;

-- Restrict EXECUTE on security-definer functions
revoke execute on function public.has_role(uuid, public.app_role) from anon, authenticated, public;
grant execute on function public.has_role(uuid, public.app_role) to service_role;

revoke execute on function public.handle_new_user() from anon, authenticated, public;
grant execute on function public.handle_new_user() to service_role;
