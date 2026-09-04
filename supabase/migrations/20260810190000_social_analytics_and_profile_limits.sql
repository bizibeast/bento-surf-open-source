begin;

alter table public.profiles
  add column if not exists social_insights_enabled boolean not null default false;

comment on column public.profiles.social_insights_enabled is
  'Whether cached connected-account social analytics are visible on the creator public Bento.';

grant select (social_insights_enabled) on public.profiles to anon, authenticated;

create table if not exists public.social_analytics_snapshots (
  connection_id uuid primary key references public.social_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_handle text not null,
  provider_display_name text not null,
  provider_avatar_url text,
  followers bigint,
  following bigint,
  posts bigint,
  views bigint,
  engagements bigint,
  status text not null default 'unavailable',
  note text,
  fetched_at timestamptz not null default to_timestamp(0),
  refresh_started_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint social_analytics_snapshot_numbers_check check (
    (followers is null or followers >= 0)
    and (following is null or following >= 0)
    and (posts is null or posts >= 0)
    and (views is null or views >= 0)
    and (engagements is null or engagements >= 0)
  ),
  constraint social_analytics_snapshot_status_check check (
    status in ('available', 'partial', 'unavailable', 'error')
  )
);

create index if not exists social_analytics_snapshots_user_idx
  on public.social_analytics_snapshots(user_id, provider);
create index if not exists social_analytics_snapshots_refresh_idx
  on public.social_analytics_snapshots(fetched_at, refresh_started_at);

alter table public.social_analytics_snapshots enable row level security;
revoke all on public.social_analytics_snapshots from public, anon, authenticated;
grant all on public.social_analytics_snapshots to service_role;

drop trigger if exists social_analytics_snapshots_updated_at
  on public.social_analytics_snapshots;
create trigger social_analytics_snapshots_updated_at
  before update on public.social_analytics_snapshots
  for each row execute function public.tg_set_updated_at();

create or replace function public.enforce_social_connection_profile_limit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(new.user_id::text || ':' || new.provider, 0)
  );

  if exists (
    select 1
    from public.social_connections connection
    where connection.user_id = new.user_id
      and connection.provider = new.provider
      and connection.provider_user_id = new.provider_user_id
  ) then
    return new;
  end if;

  if (
    select count(*)
    from public.social_connections connection
    where connection.user_id = new.user_id
      and connection.provider = new.provider
  ) >= 2 then
    raise exception 'You can connect up to 2 profiles per social platform.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_social_connection_profile_limit() from public;
grant execute on function public.enforce_social_connection_profile_limit() to service_role;

drop trigger if exists social_connections_profile_limit on public.social_connections;
create trigger social_connections_profile_limit
  before insert on public.social_connections
  for each row execute function public.enforce_social_connection_profile_limit();

notify pgrst, 'reload schema';
commit;
