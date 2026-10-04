begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

alter table public.profiles
  add column workspace_status text not null default 'active'
  constraint profiles_workspace_status_check
  check (workspace_status in ('pending', 'active', 'locked'));

create table public.workspace_memberships (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'owner' check (role = 'owner'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, workspace_id)
);

create index workspace_memberships_workspace_id_idx
  on public.workspace_memberships(workspace_id);

create table public.account_preferences (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  app_theme text not null default 'light' check (app_theme in ('light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.workspace_memberships (auth_user_id, workspace_id, role, status)
select profiles.id, profiles.id, 'owner', 'active'
from public.profiles
join auth.users on auth.users.id = profiles.id
on conflict (auth_user_id, workspace_id) do nothing;

insert into public.account_preferences (auth_user_id, app_theme)
select profiles.id, 'light'
from public.profiles
join auth.users on auth.users.id = profiles.id
on conflict (auth_user_id) do nothing;

update public.profiles set workspace_status = 'active';

alter table public.profiles drop constraint if exists profiles_id_fkey;

create function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships
    join public.profiles
      on profiles.id = workspace_memberships.workspace_id
    where workspace_memberships.auth_user_id = (select auth.uid())
      and workspace_memberships.workspace_id = p_workspace_id
      and workspace_memberships.role = 'owner'
      and workspace_memberships.status = 'active'
      and profiles.workspace_status = 'active'
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public;
revoke all on function private.is_workspace_member(uuid) from anon, authenticated, service_role;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;

grant select, update on public.workspace_memberships to authenticated;
grant all on public.workspace_memberships to service_role;
alter table public.workspace_memberships enable row level security;

create policy workspace_memberships_owner_select
  on public.workspace_memberships
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

create policy workspace_memberships_owner_update
  on public.workspace_memberships
  for update
  to authenticated
  using (
    auth_user_id = (select auth.uid())
    and role = 'owner'
    and status = 'active'
  )
  with check (
    auth_user_id = (select auth.uid())
    and role = 'owner'
    and private.is_workspace_member(workspace_id)
  );

grant select, update on public.account_preferences to authenticated;
grant all on public.account_preferences to service_role;
alter table public.account_preferences enable row level security;

create policy account_preferences_owner_select
  on public.account_preferences
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

create policy account_preferences_owner_update
  on public.account_preferences
  for update
  to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

create trigger workspace_memberships_updated_at
  before update on public.workspace_memberships
  for each row execute function public.tg_set_updated_at();

create trigger account_preferences_updated_at
  before update on public.account_preferences
  for each row execute function public.tg_set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_username text;
  candidate text;
  i integer := 0;
begin
  base_username := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), 'user'), '[^a-z0-9_]', '', 'g'));
  if length(base_username) < 3 then
    base_username := 'user' || substr(new.id::text, 1, 6);
  end if;
  candidate := substr(base_username, 1, 24);
  while exists(select 1 from public.profiles where username = candidate) loop
    i := i + 1;
    candidate := substr(base_username, 1, 20) || i::text;
  end loop;

  insert into public.profiles(id, username, display_name, workspace_status)
  values (new.id, candidate, coalesce(new.raw_user_meta_data->>'full_name', ''), 'active');
  insert into public.user_roles(user_id, role) values (new.id, 'user');
  insert into public.workspace_memberships(auth_user_id, workspace_id, role, status)
  values (new.id, new.id, 'owner', 'active');
  insert into public.account_preferences(auth_user_id, app_theme)
  values (new.id, 'light');
  return new;
end
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

commit;
