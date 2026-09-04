-- Durable, creator-owned social publishing scheduler.
-- Tokens remain service-role only; authenticated clients use audited server functions.

alter table public.social_connections
  drop constraint social_connections_provider_check,
  add constraint social_connections_provider_check check (
    provider in ('instagram', 'facebook', 'threads', 'tiktok', 'linkedin', 'twitter', 'youtube')
  ),
  add column if not exists provider_display_name text,
  add column if not exists provider_avatar_url text,
  add column if not exists refresh_token text,
  add column if not exists scopes text[] not null default '{}',
  add column if not exists status text not null default 'active',
  add column if not exists last_refreshed_at timestamptz,
  add column if not exists last_error text,
  add constraint social_connections_status_check check (
    status in ('active', 'expired', 'revoked', 'error')
  );

-- A creator may connect the same provider account to their own workspace only.
-- Including user_id prevents a service-role upsert from ever reassigning another
-- creator's connection when two Bento users authorize the same social account.
alter table public.social_connections
  drop constraint if exists social_connections_provider_provider_user_id_key;

alter table public.social_connections
  add constraint social_connections_owner_provider_account_key
  unique (user_id, provider, provider_user_id);

alter table public.social_oauth_states
  drop constraint social_oauth_states_provider_check,
  add constraint social_oauth_states_provider_check check (
    provider in ('instagram', 'facebook', 'threads', 'tiktok', 'linkedin', 'twitter', 'youtube')
  ),
  add column if not exists code_verifier text,
  add column if not exists redirect_uri text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  title text,
  scheduled_at timestamptz,
  timezone text not null default 'UTC',
  status text not null default 'draft',
  media jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_posts_body_length check (length(body) <= 10000),
  constraint social_posts_media_array check (jsonb_typeof(media) = 'array'),
  constraint social_posts_status_check check (
    status in ('draft', 'scheduled', 'publishing', 'published', 'partially_failed', 'failed', 'cancelled')
  )
);

create index social_posts_owner_created_idx on public.social_posts(user_id, created_at desc);
create index social_posts_schedule_idx on public.social_posts(status, scheduled_at)
  where status = 'scheduled';

create table public.social_post_targets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  provider text not null,
  status text not null default 'pending',
  provider_settings jsonb not null default '{}'::jsonb,
  remote_post_id text,
  remote_post_url text,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  idempotency_key uuid not null default gen_random_uuid(),
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_post_targets_provider_check check (
    provider in ('instagram', 'facebook', 'threads', 'tiktok', 'linkedin', 'twitter', 'youtube')
  ),
  constraint social_post_targets_status_check check (
    status in ('pending', 'queued', 'publishing', 'published', 'retrying', 'failed', 'cancelled')
  ),
  constraint social_post_targets_attempts_check check (attempt_count between 0 and 20),
  unique (post_id, connection_id),
  unique (idempotency_key)
);

create index social_post_targets_due_idx
  on public.social_post_targets(status, next_attempt_at, lease_expires_at);
create index social_post_targets_post_idx on public.social_post_targets(post_id);

create table public.social_publish_attempts (
  id bigint generated always as identity primary key,
  target_id uuid not null references public.social_post_targets(id) on delete cascade,
  attempt integer not null,
  outcome text not null,
  response_status integer,
  error_code text,
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint social_publish_attempts_outcome_check check (
    outcome in ('started', 'published', 'retrying', 'failed')
  )
);

create index social_publish_attempts_target_idx
  on public.social_publish_attempts(target_id, created_at desc);

alter table public.social_posts enable row level security;
alter table public.social_post_targets enable row level security;
alter table public.social_publish_attempts enable row level security;

revoke all on public.social_posts from anon, authenticated;
revoke all on public.social_post_targets from anon, authenticated;
revoke all on public.social_publish_attempts from anon, authenticated;
grant all on public.social_posts to service_role;
grant all on public.social_post_targets to service_role;
grant all on public.social_publish_attempts to service_role;

create trigger social_posts_updated_at
  before update on public.social_posts
  for each row execute function public.tg_set_updated_at();

create trigger social_post_targets_updated_at
  before update on public.social_post_targets
  for each row execute function public.tg_set_updated_at();

-- Atomically lease due targets. Cloudflare Queues is at-least-once, so a target's
-- idempotency key and lease make duplicate deliveries safe to ignore.
create or replace function public.claim_due_social_targets(
  claim_limit integer default 50,
  lease_seconds integer default 300
)
returns table(target_id uuid, idempotency_key uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select target.id
    from public.social_post_targets target
    join public.social_posts post on post.id = target.post_id
    join public.social_connections connection on connection.id = target.connection_id
    where post.status in ('scheduled', 'publishing')
      and post.cancelled_at is null
      and coalesce(post.scheduled_at, now()) <= now()
      and target.status in ('pending', 'retrying', 'queued')
      and coalesce(target.next_attempt_at, post.scheduled_at, now()) <= now()
      and (target.lease_expires_at is null or target.lease_expires_at <= now())
      and connection.status = 'active'
    order by coalesce(post.scheduled_at, now()), target.created_at
    for update of target skip locked
    limit greatest(1, least(claim_limit, 100))
  )
  update public.social_post_targets target
  set status = 'queued',
      lease_expires_at = now() + make_interval(secs => greatest(30, least(lease_seconds, 900))),
      updated_at = now()
  from due
  where target.id = due.id
  returning target.id, target.idempotency_key;
end;
$$;

revoke all on function public.claim_due_social_targets(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_due_social_targets(integer, integer) to service_role;
