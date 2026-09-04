-- Enforce Instagram automation tenant ownership at the database boundary.
-- The application already scopes every write by the authenticated creator;
-- these triggers make that invariant impossible to bypass accidentally from
-- future service-role code or RPC changes.

do $$
begin
  if exists (
    select 1
    from public.instagram_dm_automations automation
    left join public.social_connections connection
      on connection.id = automation.connection_id
    where connection.id is null
      or connection.provider <> 'instagram'
      or connection.user_id <> automation.user_id
  ) then
    raise exception 'Existing Instagram automation ownership is inconsistent';
  end if;

  if exists (
    select 1
    from public.instagram_dm_runs run
    left join public.instagram_dm_automations automation
      on automation.id = run.automation_id
    where automation.id is null
      or automation.connection_id <> run.connection_id
      or automation.user_id <> run.user_id
  ) then
    raise exception 'Existing Instagram workflow ownership is inconsistent';
  end if;

  if exists (
    select 1
    from public.instagram_dm_events event
    join public.instagram_dm_automations automation
      on automation.id = event.automation_id
    where event.connection_id is not null
      and automation.connection_id <> event.connection_id
  ) then
    raise exception 'Existing Instagram event ownership is inconsistent';
  end if;
end;
$$;

create or replace function public.enforce_instagram_automation_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.social_connections connection
    where connection.id = new.connection_id
      and connection.user_id = new.user_id
      and connection.provider = 'instagram'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Instagram automation connection must belong to its creator';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_instagram_run_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.instagram_dm_automations automation
    where automation.id = new.automation_id
      and automation.connection_id = new.connection_id
      and automation.user_id = new.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Instagram workflow must match its automation owner and connection';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_instagram_event_connection()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.connection_id is not null and not exists (
    select 1
    from public.social_connections connection
    where connection.id = new.connection_id
      and connection.provider = 'instagram'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Instagram event connection must reference an Instagram account';
  end if;

  if new.connection_id is not null
    and new.automation_id is not null
    and not exists (
      select 1
      from public.instagram_dm_automations automation
      where automation.id = new.automation_id
        and automation.connection_id = new.connection_id
    ) then
    raise exception using
      errcode = '23514',
      message = 'Instagram event automation must match its connection';
  end if;

  return new;
end;
$$;

drop trigger if exists instagram_dm_automations_enforce_owner
  on public.instagram_dm_automations;
create trigger instagram_dm_automations_enforce_owner
  before insert or update of user_id, connection_id
  on public.instagram_dm_automations
  for each row execute function public.enforce_instagram_automation_owner();

drop trigger if exists instagram_dm_runs_enforce_owner
  on public.instagram_dm_runs;
create trigger instagram_dm_runs_enforce_owner
  before insert or update of automation_id, connection_id, user_id
  on public.instagram_dm_runs
  for each row execute function public.enforce_instagram_run_owner();

drop trigger if exists instagram_dm_events_enforce_connection
  on public.instagram_dm_events;
create trigger instagram_dm_events_enforce_connection
  before insert or update of connection_id, automation_id
  on public.instagram_dm_events
  for each row execute function public.enforce_instagram_event_connection();

revoke all on function public.enforce_instagram_automation_owner()
  from public, anon, authenticated;
revoke all on function public.enforce_instagram_run_owner()
  from public, anon, authenticated;
revoke all on function public.enforce_instagram_event_connection()
  from public, anon, authenticated;

grant execute on function public.enforce_instagram_automation_owner() to service_role;
grant execute on function public.enforce_instagram_run_owner() to service_role;
grant execute on function public.enforce_instagram_event_connection() to service_role;

comment on function public.enforce_instagram_automation_owner() is
  'Prevents an Instagram automation from referencing another creator''s connection.';
comment on function public.enforce_instagram_run_owner() is
  'Keeps durable Instagram workflow state bound to its automation owner and connection.';
comment on function public.enforce_instagram_event_connection() is
  'Keeps processed Instagram events bound to the automation connection that handled them.';
