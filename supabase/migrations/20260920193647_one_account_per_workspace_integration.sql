begin;

with automated_connections as (
  select connection_id from public.instagram_dm_automations where enabled
  union
  select connection_id from public.facebook_dm_automations where enabled
  union
  select connection_id from public.twitter_dm_automations where enabled
), ranked as (
  select
    connection.id,
    row_number() over (
      partition by connection.user_id, connection.provider
      order by
        (automated.connection_id is not null) desc,
        connection.updated_at desc,
        connection.id desc
    ) as position
  from public.social_connections connection
  left join automated_connections automated on automated.connection_id = connection.id
  where connection.status = 'active'
)
update public.social_connections connection
set status = 'revoked',
    connection_health = 'action_required',
    reauth_required = true,
    last_error = 'Replaced by the workspace active provider account.',
    updated_at = now()
from ranked
where ranked.id = connection.id
  and ranked.position > 1;

create function private.replace_active_social_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' then
    update public.social_connections
    set status = 'revoked',
        connection_health = 'action_required',
        reauth_required = true,
        last_error = 'Replaced by a new provider account.',
        updated_at = now()
    where user_id = new.user_id
      and provider = new.provider
      and id <> new.id
      and status = 'active';
  end if;
  return new;
end
$$;

revoke all on function private.replace_active_social_connection() from public, anon, authenticated;
create trigger social_connections_replace_active
  before insert or update of user_id, provider, status on public.social_connections
  for each row execute function private.replace_active_social_connection();

create unique index social_connections_one_active_provider
  on public.social_connections(user_id, provider)
  where status = 'active';

with ranked as (
  select
    connection.id,
    row_number() over (
      partition by connection.user_id, connection.provider
      order by connection.updated_at desc, connection.id desc
    ) as position
  from public.content_connections connection
  where connection.status = 'active'
)
update public.content_connections connection
set status = 'disconnected',
    last_error = 'Replaced by the workspace active provider account.',
    updated_at = now()
from ranked
where ranked.id = connection.id
  and ranked.position > 1;

create function private.replace_active_content_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' then
    update public.content_connections
    set status = 'disconnected',
        last_error = 'Replaced by a new provider account.',
        updated_at = now()
    where user_id = new.user_id
      and provider = new.provider
      and id <> new.id
      and status = 'active';
  end if;
  return new;
end
$$;

revoke all on function private.replace_active_content_connection() from public, anon, authenticated;
create trigger content_connections_replace_active
  before insert or update of user_id, provider, status on public.content_connections
  for each row execute function private.replace_active_content_connection();

create unique index content_connections_one_active_provider
  on public.content_connections(user_id, provider)
  where status = 'active';

commit;
