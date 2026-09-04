-- Social scheduler completion: drafts, reschedule, Pinterest, outbox,
-- outcome_unknown, and YouTube upload session persistence.
-- Apply only after reconciling remote migration history with this repo.

-- ---------------------------------------------------------------------------
-- Provider constraints: add Pinterest
-- ---------------------------------------------------------------------------
alter table public.social_connections
  drop constraint if exists social_connections_provider_check;

alter table public.social_connections
  add constraint social_connections_provider_check
  check (provider in (
    'instagram',
    'facebook',
    'threads',
    'tiktok',
    'linkedin',
    'twitter',
    'youtube',
    'reddit',
    'pinterest'
  ));

alter table public.social_oauth_states
  drop constraint if exists social_oauth_states_provider_check;

alter table public.social_oauth_states
  add constraint social_oauth_states_provider_check
  check (provider in (
    'instagram',
    'facebook',
    'threads',
    'tiktok',
    'linkedin',
    'twitter',
    'youtube',
    'reddit',
    'pinterest'
  ));

alter table public.social_post_targets
  drop constraint if exists social_post_targets_provider_check;

alter table public.social_post_targets
  add constraint social_post_targets_provider_check
  check (provider in (
    'instagram',
    'facebook',
    'threads',
    'tiktok',
    'linkedin',
    'twitter',
    'youtube',
    'reddit',
    'pinterest'
  ));

-- ---------------------------------------------------------------------------
-- Target statuses: outcome_unknown + upload session columns
-- ---------------------------------------------------------------------------
alter table public.social_post_targets
  drop constraint if exists social_post_targets_status_check;

alter table public.social_post_targets
  add constraint social_post_targets_status_check
  check (status in (
    'pending',
    'queued',
    'publishing',
    'processing',
    'published',
    'retrying',
    'failed',
    'cancelled',
    'outcome_unknown'
  ));

alter table public.social_post_targets
  add column if not exists upload_session_url text,
  add column if not exists upload_byte_offset bigint not null default 0,
  add column if not exists last_reconcile_at timestamptz;

alter table public.social_publish_attempts
  drop constraint if exists social_publish_attempts_outcome_check;

alter table public.social_publish_attempts
  add constraint social_publish_attempts_outcome_check
  check (outcome in (
    'started',
    'submitted',
    'published',
    'retrying',
    'failed',
    'outcome_unknown'
  ));

-- ---------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------
create table if not exists public.social_outbox_events (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.social_post_targets(id) on delete cascade,
  idempotency_key uuid not null,
  provider text not null,
  event_type text not null default 'publish',
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'delivered', 'failed')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (target_id, event_type)
);

create index if not exists social_outbox_events_claim_idx
  on public.social_outbox_events (status, available_at, created_at);

alter table public.social_outbox_events enable row level security;

revoke all on table public.social_outbox_events from public, anon, authenticated;
grant select, insert, update, delete on table public.social_outbox_events to service_role;

-- ---------------------------------------------------------------------------
-- Atomic save: drafts + scheduled + outbox rows
-- ---------------------------------------------------------------------------
create or replace function public.save_social_post_atomic(
  p_user_id uuid,
  p_post_id uuid,
  p_body text,
  p_title text,
  p_media jsonb,
  p_scheduled_at timestamptz,
  p_timezone text,
  p_targets jsonb,
  p_as_draft boolean
)
returns table(saved_post_id uuid, target_id uuid, idempotency_key uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_post_id uuid;
  v_post_status text;
  v_status text;
begin
  if p_user_id is null then
    raise exception 'A creator is required.' using errcode = '22023';
  end if;

  if not coalesce(p_as_draft, false) and p_scheduled_at is null then
    raise exception 'A publishing time is required.' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_media, '[]'::jsonb)) <> 'array' then
    raise exception 'Media must be an array.' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_targets, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_targets, '[]'::jsonb)) = 0 then
    raise exception 'Choose at least one publishing destination.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_targets) target
    group by target.value ->> 'connectionId'
    having count(*) > 1
  ) then
    raise exception 'A publishing destination was selected more than once.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_targets) target
    left join public.social_connections connection
      on connection.id = (target.value ->> 'connectionId')::uuid
    where connection.id is null
      or connection.user_id <> p_user_id
      or connection.provider <> target.value ->> 'provider'
      or connection.status <> 'active'
  ) then
    raise exception 'One or more publishing destinations are unavailable.' using errcode = '22023';
  end if;

  v_status := case when coalesce(p_as_draft, false) then 'draft' else 'scheduled' end;

  if p_post_id is not null then
    select post.id, post.status
    into v_post_id, v_post_status
    from public.social_posts post
    where post.id = p_post_id
      and post.user_id = p_user_id
    for update;

    if not found then
      raise exception 'The scheduled post was not found.' using errcode = 'P0002';
    end if;

    if v_post_status not in ('draft', 'scheduled', 'failed', 'partially_failed') then
      raise exception 'This post can no longer be edited.' using errcode = '55000';
    end if;

    if exists (
      select 1
      from public.social_post_targets target
      where target.post_id = v_post_id
        and target.status in ('publishing', 'processing', 'published', 'outcome_unknown')
    ) then
      raise exception 'A post already sent to a social network cannot be edited.' using errcode = '55000';
    end if;

    update public.social_posts
    set body = p_body,
        title = nullif(p_title, ''),
        media = coalesce(p_media, '[]'::jsonb),
        scheduled_at = p_scheduled_at,
        timezone = coalesce(nullif(p_timezone, ''), 'UTC'),
        status = v_status,
        published_at = null,
        cancelled_at = null
    where id = v_post_id;

    delete from public.social_outbox_events outbox
    using public.social_post_targets target
    where target.post_id = v_post_id
      and outbox.target_id = target.id;

    delete from public.social_post_targets target
    where target.post_id = v_post_id;
  else
    insert into public.social_posts (
      user_id,
      body,
      title,
      media,
      scheduled_at,
      timezone,
      status
    )
    values (
      p_user_id,
      p_body,
      nullif(p_title, ''),
      coalesce(p_media, '[]'::jsonb),
      p_scheduled_at,
      coalesce(nullif(p_timezone, ''), 'UTC'),
      v_status
    )
    returning id into v_post_id;
  end if;

  return query
  with inserted as (
    insert into public.social_post_targets (
      post_id,
      connection_id,
      provider,
      provider_settings,
      next_attempt_at,
      status
    )
    select
      v_post_id,
      (target.value ->> 'connectionId')::uuid,
      target.value ->> 'provider',
      coalesce(target.value -> 'providerSettings', '{}'::jsonb),
      case when coalesce(p_as_draft, false) then null else p_scheduled_at end,
      case when coalesce(p_as_draft, false) then 'pending' else 'pending' end
    from jsonb_array_elements(p_targets) target
    returning
      public.social_post_targets.post_id,
      public.social_post_targets.id,
      public.social_post_targets.idempotency_key,
      public.social_post_targets.provider
  ),
  outbox as (
    insert into public.social_outbox_events (
      target_id,
      idempotency_key,
      provider,
      event_type,
      payload,
      status,
      available_at
    )
    select
      inserted.id,
      inserted.idempotency_key,
      inserted.provider,
      'publish',
      jsonb_build_object(
        'targetId', inserted.id,
        'idempotencyKey', inserted.idempotency_key,
        'provider', inserted.provider
      ),
      case when coalesce(p_as_draft, false) then 'pending' else 'pending' end,
      case when coalesce(p_as_draft, false) then 'infinity'::timestamptz else p_scheduled_at end
    from inserted
    where not coalesce(p_as_draft, false)
    returning target_id
  )
  select inserted.post_id, inserted.id, inserted.idempotency_key
  from inserted;
end;
$$;

revoke all on function public.save_social_post_atomic(
  uuid, uuid, text, text, jsonb, timestamptz, text, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.save_social_post_atomic(
  uuid, uuid, text, text, jsonb, timestamptz, text, jsonb, boolean
) to service_role;

-- Keep the previous 8-arg signature callable by wrapping into the draft-aware function.
create or replace function public.save_social_post_atomic(
  p_user_id uuid,
  p_post_id uuid,
  p_body text,
  p_title text,
  p_media jsonb,
  p_scheduled_at timestamptz,
  p_timezone text,
  p_targets jsonb
)
returns table(saved_post_id uuid, target_id uuid, idempotency_key uuid)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select * from public.save_social_post_atomic(
    p_user_id,
    p_post_id,
    p_body,
    p_title,
    p_media,
    p_scheduled_at,
    p_timezone,
    p_targets,
    false
  );
$$;

revoke all on function public.save_social_post_atomic(
  uuid, uuid, text, text, jsonb, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_social_post_atomic(
  uuid, uuid, text, text, jsonb, timestamptz, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Reschedule a draft/scheduled post
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_social_post_atomic(
  p_user_id uuid,
  p_post_id uuid,
  p_scheduled_at timestamptz,
  p_timezone text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if p_scheduled_at is null then
    raise exception 'A publishing time is required.' using errcode = '22023';
  end if;

  select post.status
  into v_status
  from public.social_posts post
  where post.id = p_post_id
    and post.user_id = p_user_id
  for update;

  if not found then
    raise exception 'The scheduled post was not found.' using errcode = 'P0002';
  end if;

  if v_status not in ('draft', 'scheduled', 'failed', 'partially_failed') then
    raise exception 'This post can no longer be rescheduled.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.social_post_targets target
    where target.post_id = p_post_id
      and target.status in ('publishing', 'processing', 'published', 'outcome_unknown', 'queued')
  ) then
    raise exception 'A post already in flight cannot be rescheduled.' using errcode = '55000';
  end if;

  update public.social_posts
  set scheduled_at = p_scheduled_at,
      timezone = coalesce(nullif(p_timezone, ''), timezone, 'UTC'),
      status = 'scheduled',
      cancelled_at = null
  where id = p_post_id;

  update public.social_post_targets
  set status = 'pending',
      next_attempt_at = p_scheduled_at,
      lease_expires_at = null,
      last_error_code = null,
      last_error_message = null
  where post_id = p_post_id
    and status in ('pending', 'retrying', 'failed', 'cancelled');

  insert into public.social_outbox_events (
    target_id,
    idempotency_key,
    provider,
    event_type,
    payload,
    status,
    available_at
  )
  select
    target.id,
    target.idempotency_key,
    target.provider,
    'publish',
    jsonb_build_object(
      'targetId', target.id,
      'idempotencyKey', target.idempotency_key,
      'provider', target.provider
    ),
    'pending',
    p_scheduled_at
  from public.social_post_targets target
  where target.post_id = p_post_id
  on conflict (target_id, event_type) do update
    set status = 'pending',
        available_at = excluded.available_at,
        claimed_at = null,
        delivered_at = null,
        last_error = null,
        attempt_count = 0,
        payload = excluded.payload;

  return true;
end;
$$;

revoke all on function public.reschedule_social_post_atomic(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.reschedule_social_post_atomic(uuid, uuid, timestamptz, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Duplicate a post as a new draft
-- ---------------------------------------------------------------------------
create or replace function public.duplicate_social_post_atomic(
  p_user_id uuid,
  p_post_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source public.social_posts%rowtype;
  v_new_id uuid;
begin
  select *
  into v_source
  from public.social_posts post
  where post.id = p_post_id
    and post.user_id = p_user_id;

  if not found then
    raise exception 'The post was not found.' using errcode = 'P0002';
  end if;

  insert into public.social_posts (
    user_id,
    body,
    title,
    media,
    scheduled_at,
    timezone,
    status
  )
  values (
    p_user_id,
    v_source.body,
    v_source.title,
    v_source.media,
    null,
    v_source.timezone,
    'draft'
  )
  returning id into v_new_id;

  insert into public.social_post_targets (
    post_id,
    connection_id,
    provider,
    provider_settings,
    next_attempt_at,
    status
  )
  select
    v_new_id,
    target.connection_id,
    target.provider,
    target.provider_settings,
    null,
    'pending'
  from public.social_post_targets target
  where target.post_id = p_post_id
    and exists (
      select 1
      from public.social_connections connection
      where connection.id = target.connection_id
        and connection.user_id = p_user_id
        and connection.status = 'active'
    );

  return v_new_id;
end;
$$;

revoke all on function public.duplicate_social_post_atomic(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.duplicate_social_post_atomic(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Outbox claim / mark delivered / repair
-- ---------------------------------------------------------------------------
create or replace function public.claim_social_outbox_events(
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns table(
  outbox_id uuid,
  target_id uuid,
  idempotency_key uuid,
  provider text,
  payload jsonb
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select event.id
    from public.social_outbox_events event
    where (
        event.status = 'pending'
        and event.available_at <= now()
      )
      or (
        event.status = 'claimed'
        and event.claimed_at < now() - make_interval(secs => greatest(p_lease_seconds, 30))
      )
    order by event.available_at asc, event.created_at asc
    for update skip locked
    limit greatest(coalesce(p_limit, 25), 1)
  ),
  claimed as (
    update public.social_outbox_events event
    set status = 'claimed',
        claimed_at = now(),
        attempt_count = event.attempt_count + 1
    from due
    where event.id = due.id
    returning
      event.id,
      event.target_id,
      event.idempotency_key,
      event.provider,
      event.payload
  )
  select
    claimed.id,
    claimed.target_id,
    claimed.idempotency_key,
    claimed.provider,
    claimed.payload
  from claimed;
end;
$$;

revoke all on function public.claim_social_outbox_events(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_social_outbox_events(integer, integer)
  to service_role;

create or replace function public.mark_social_outbox_delivered(
  p_outbox_ids uuid[]
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.social_outbox_events
  set status = 'delivered',
      delivered_at = now(),
      last_error = null
  where id = any(coalesce(p_outbox_ids, '{}'::uuid[]))
    and status = 'claimed';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_social_outbox_delivered(uuid[])
  from public, anon, authenticated;
grant execute on function public.mark_social_outbox_delivered(uuid[])
  to service_role;

create or replace function public.repair_social_outbox_events()
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  with missing as (
    insert into public.social_outbox_events (
      target_id,
      idempotency_key,
      provider,
      event_type,
      payload,
      status,
      available_at
    )
    select
      target.id,
      target.idempotency_key,
      target.provider,
      'publish',
      jsonb_build_object(
        'targetId', target.id,
        'idempotencyKey', target.idempotency_key,
        'provider', target.provider
      ),
      'pending',
      coalesce(target.next_attempt_at, now())
    from public.social_post_targets target
    join public.social_posts post on post.id = target.post_id
    where post.status = 'scheduled'
      and target.status in ('pending', 'retrying')
      and target.next_attempt_at is not null
      and not exists (
        select 1
        from public.social_outbox_events outbox
        where outbox.target_id = target.id
          and outbox.event_type = 'publish'
      )
    on conflict (target_id, event_type) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from missing;

  return coalesce(v_inserted, 0);
end;
$$;

revoke all on function public.repair_social_outbox_events()
  from public, anon, authenticated;
grant execute on function public.repair_social_outbox_events()
  to service_role;

-- Allow outcome_unknown targets to re-enter the claim path for reconciliation.
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
    where post.status in ('scheduled', 'publishing', 'partially_failed')
      and post.cancelled_at is null
      and coalesce(post.scheduled_at, now()) <= now()
      and target.status in ('pending', 'retrying', 'queued', 'processing', 'outcome_unknown')
      and coalesce(target.next_attempt_at, post.scheduled_at, now()) <= now()
      and (target.lease_expires_at is null or target.lease_expires_at <= now())
      and connection.status = 'active'
    order by coalesce(target.next_attempt_at, post.scheduled_at, now()), target.created_at
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

revoke all on function public.claim_due_social_targets(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_social_targets(integer, integer)
  to service_role;
