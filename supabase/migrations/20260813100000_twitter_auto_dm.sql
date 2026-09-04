-- Creator-owned X (Twitter) inbound-DM and mention-to-DM automations.
-- Message bodies are processed ephemerally by the Worker and are not retained.

alter table public.social_connections
  add column if not exists last_twitter_dm_reconcile_completed_at timestamptz,
  add column if not exists last_twitter_dm_reconcile_error text;

create table public.twitter_dm_automations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  name text not null,
  trigger_type text not null,
  keywords text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  match_type text not null default 'contains',
  reply_message text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint twitter_dm_automations_name_length check (length(name) between 1 and 80),
  constraint twitter_dm_automations_trigger_check check (
    trigger_type in ('dm_keyword', 'any_dm', 'mention_keyword', 'any_mention')
  ),
  constraint twitter_dm_automations_match_check check (match_type in ('contains', 'exact')),
  constraint twitter_dm_automations_keywords_count check (cardinality(keywords) <= 20),
  constraint twitter_dm_automations_excluded_count check (cardinality(excluded_keywords) <= 20),
  constraint twitter_dm_automations_keywords_bytes check (octet_length(keywords::text) <= 4000),
  constraint twitter_dm_automations_excluded_bytes check (octet_length(excluded_keywords::text) <= 4000),
  constraint twitter_dm_automations_keywords_required check (
    trigger_type in ('any_dm', 'any_mention') or cardinality(keywords) > 0
  ),
  constraint twitter_dm_automations_reply_length check (length(reply_message) between 1 and 10000)
);

create index twitter_dm_automations_owner_idx
  on public.twitter_dm_automations(user_id, created_at desc);
create index twitter_dm_automations_connection_enabled_idx
  on public.twitter_dm_automations(connection_id, enabled, created_at);

create table public.twitter_dm_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  twitter_user_id text not null,
  connection_id uuid references public.social_connections(id) on delete set null,
  automation_id uuid references public.twitter_dm_automations(id) on delete set null,
  event_type text not null,
  source_id text not null,
  sender_username text,
  sender_id_hash text,
  matched_keyword text,
  status text not null default 'received',
  attempt_count integer not null default 0,
  response_id text,
  error_code text,
  error_message text,
  occurred_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint twitter_dm_events_type_check check (event_type in ('dm', 'mention')),
  constraint twitter_dm_events_status_check check (
    status in ('received', 'processing', 'sent', 'ignored', 'failed')
  ),
  constraint twitter_dm_events_attempts_check check (attempt_count between 0 and 10),
  constraint twitter_dm_events_external_id_length check (length(external_event_id) between 1 and 600),
  constraint twitter_dm_events_account_length check (length(twitter_user_id) between 1 and 255),
  constraint twitter_dm_events_source_length check (length(source_id) between 1 and 255)
);

create index twitter_dm_events_connection_created_idx
  on public.twitter_dm_events(connection_id, created_at desc);
create index twitter_dm_events_automation_created_idx
  on public.twitter_dm_events(automation_id, created_at desc);
create index twitter_dm_events_status_created_idx
  on public.twitter_dm_events(status, created_at desc);

alter table public.twitter_dm_automations enable row level security;
alter table public.twitter_dm_events enable row level security;

revoke all on public.twitter_dm_automations from public, anon, authenticated;
revoke all on public.twitter_dm_events from public, anon, authenticated;
grant all on public.twitter_dm_automations to service_role;
grant all on public.twitter_dm_events to service_role;

create trigger twitter_dm_automations_updated_at
  before update on public.twitter_dm_automations
  for each row execute function public.tg_set_updated_at();

create trigger twitter_dm_events_updated_at
  before update on public.twitter_dm_events
  for each row execute function public.tg_set_updated_at();

create or replace function public.claim_twitter_dm_event(
  p_external_event_id text,
  p_twitter_user_id text,
  p_event_type text,
  p_source_id text,
  p_sender_username text default null,
  p_sender_id_hash text default null,
  p_occurred_at timestamptz default null
)
returns table(event_id uuid, should_process boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  insert into public.twitter_dm_events (
    external_event_id,
    twitter_user_id,
    event_type,
    source_id,
    sender_username,
    sender_id_hash,
    occurred_at
  ) values (
    p_external_event_id,
    p_twitter_user_id,
    p_event_type,
    p_source_id,
    p_sender_username,
    p_sender_id_hash,
    p_occurred_at
  )
  on conflict (external_event_id) do nothing;

  update public.twitter_dm_events event
  set status = 'processing',
      attempt_count = event.attempt_count + 1,
      error_code = null,
      error_message = null,
      updated_at = now()
  where event.external_event_id = p_external_event_id
    and event.status in ('received', 'failed')
    and event.attempt_count < 5
  returning event.id into claimed_id;

  if claimed_id is null then
    select event.id into claimed_id
    from public.twitter_dm_events event
    where event.external_event_id = p_external_event_id;
    return query select claimed_id, false;
  end if;

  return query select claimed_id, true;
end;
$$;

revoke all on function public.claim_twitter_dm_event(
  text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_twitter_dm_event(
  text, text, text, text, text, text, timestamptz
) to service_role;

create or replace function public.claim_twitter_dm_reconciliations(
  p_batch_size integer default 25,
  p_min_interval_seconds integer default 300
)
returns table(connection_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select connection.id
    from public.social_connections connection
    where connection.provider = 'twitter'
      and connection.status = 'active'
      and connection.connection_health = 'healthy'
      and coalesce(connection.reauth_required, false) = false
      and (
        connection.last_twitter_dm_reconcile_completed_at is null
        or connection.last_twitter_dm_reconcile_completed_at
          < now() - make_interval(secs => greatest(p_min_interval_seconds, 60))
      )
      and exists (
        select 1
        from public.twitter_dm_automations automation
        where automation.connection_id = connection.id
          and automation.enabled = true
      )
    order by connection.last_twitter_dm_reconcile_completed_at asc nulls first, connection.id
    limit greatest(p_batch_size, 1)
    for update skip locked
  )
  select candidates.id as connection_id
  from candidates;
end;
$$;

revoke all on function public.claim_twitter_dm_reconciliations(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_twitter_dm_reconciliations(integer, integer)
  to service_role;
