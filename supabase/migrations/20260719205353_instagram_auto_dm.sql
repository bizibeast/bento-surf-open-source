-- Creator-owned Instagram comment-to-DM and inbound-keyword automations.
-- Message bodies are processed ephemerally by the Worker and are not retained.

create table public.instagram_dm_automations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  name text not null,
  trigger_type text not null,
  keywords text[] not null default '{}',
  match_type text not null default 'contains',
  media_ids text[] not null default '{}',
  reply_message text not null,
  public_reply_enabled boolean not null default false,
  public_reply_message text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_dm_automations_name_length check (length(name) between 1 and 80),
  constraint instagram_dm_automations_trigger_check check (
    trigger_type in ('comment_keyword', 'any_comment', 'dm_keyword')
  ),
  constraint instagram_dm_automations_match_check check (match_type in ('contains', 'exact')),
  constraint instagram_dm_automations_keywords_count check (cardinality(keywords) <= 20),
  constraint instagram_dm_automations_media_count check (cardinality(media_ids) <= 100),
  constraint instagram_dm_automations_keywords_bytes check (octet_length(keywords::text) <= 4000),
  constraint instagram_dm_automations_media_bytes check (octet_length(media_ids::text) <= 30000),
  constraint instagram_dm_automations_keywords_required check (
    trigger_type = 'any_comment' or cardinality(keywords) > 0
  ),
  constraint instagram_dm_automations_reply_length check (length(reply_message) between 1 and 1000),
  constraint instagram_dm_automations_public_reply check (
    (not public_reply_enabled and public_reply_message is null)
    or (public_reply_enabled and length(public_reply_message) between 1 and 300)
  )
);

create index instagram_dm_automations_owner_idx
  on public.instagram_dm_automations(user_id, created_at desc);
create index instagram_dm_automations_connection_enabled_idx
  on public.instagram_dm_automations(connection_id, enabled, created_at);

create table public.instagram_dm_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  instagram_account_id text not null,
  connection_id uuid references public.social_connections(id) on delete set null,
  automation_id uuid references public.instagram_dm_automations(id) on delete set null,
  event_type text not null,
  source_id text not null,
  media_id text,
  sender_username text,
  sender_id_hash text,
  matched_keyword text,
  status text not null default 'received',
  attempt_count integer not null default 0,
  response_id text,
  public_reply_id text,
  error_code text,
  error_message text,
  occurred_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_dm_events_type_check check (event_type in ('comment', 'message')),
  constraint instagram_dm_events_status_check check (
    status in ('received', 'processing', 'sent', 'ignored', 'failed')
  ),
  constraint instagram_dm_events_attempts_check check (attempt_count between 0 and 10),
  constraint instagram_dm_events_external_id_length check (length(external_event_id) between 1 and 600),
  constraint instagram_dm_events_account_length check (length(instagram_account_id) between 1 and 255),
  constraint instagram_dm_events_source_length check (length(source_id) between 1 and 255)
);

create index instagram_dm_events_connection_created_idx
  on public.instagram_dm_events(connection_id, created_at desc);
create index instagram_dm_events_automation_created_idx
  on public.instagram_dm_events(automation_id, created_at desc);
create index instagram_dm_events_status_created_idx
  on public.instagram_dm_events(status, created_at desc);

alter table public.instagram_dm_automations enable row level security;
alter table public.instagram_dm_events enable row level security;

revoke all on public.instagram_dm_automations from public, anon, authenticated;
revoke all on public.instagram_dm_events from public, anon, authenticated;
grant all on public.instagram_dm_automations to service_role;
grant all on public.instagram_dm_events to service_role;

create trigger instagram_dm_automations_updated_at
  before update on public.instagram_dm_automations
  for each row execute function public.tg_set_updated_at();

create trigger instagram_dm_events_updated_at
  before update on public.instagram_dm_events
  for each row execute function public.tg_set_updated_at();

-- Queue deliveries are at-least-once. This function provides an atomic claim so
-- duplicate Meta deliveries and Cloudflare retries cannot send the DM twice.
create or replace function public.claim_instagram_dm_event(
  p_external_event_id text,
  p_instagram_account_id text,
  p_event_type text,
  p_source_id text,
  p_media_id text default null,
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
  insert into public.instagram_dm_events (
    external_event_id,
    instagram_account_id,
    event_type,
    source_id,
    media_id,
    sender_username,
    sender_id_hash,
    occurred_at
  ) values (
    p_external_event_id,
    p_instagram_account_id,
    p_event_type,
    p_source_id,
    p_media_id,
    p_sender_username,
    p_sender_id_hash,
    p_occurred_at
  )
  on conflict (external_event_id) do nothing;

  update public.instagram_dm_events event
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
    from public.instagram_dm_events event
    where event.external_event_id = p_external_event_id;
    return query select claimed_id, false;
  end if;

  return query select claimed_id, true;
end;
$$;

revoke all on function public.claim_instagram_dm_event(
  text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_event(
  text, text, text, text, text, text, text, timestamptz
) to service_role;
