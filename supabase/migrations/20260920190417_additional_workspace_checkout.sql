begin;

create function public.create_pending_workspace(
  p_auth_user_id uuid,
  p_display_name text,
  p_username text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := gen_random_uuid();
begin
  if not exists (select 1 from auth.users where id = p_auth_user_id) then
    raise exception 'Authenticated user not found';
  end if;
  if p_username !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Invalid workspace username';
  end if;
  if length(trim(p_display_name)) not between 1 and 60 then
    raise exception 'Invalid workspace display name';
  end if;

  insert into public.profiles(id, username, display_name, workspace_status)
  values (workspace_id, p_username, trim(p_display_name), 'pending');

  insert into public.workspace_memberships(auth_user_id, workspace_id, role, status)
  values (p_auth_user_id, workspace_id, 'owner', 'active');

  return workspace_id;
end
$$;

revoke all on function public.create_pending_workspace(uuid, text, text) from public;
revoke all on function public.create_pending_workspace(uuid, text, text) from anon, authenticated;
grant execute on function public.create_pending_workspace(uuid, text, text) to service_role;

commit;
