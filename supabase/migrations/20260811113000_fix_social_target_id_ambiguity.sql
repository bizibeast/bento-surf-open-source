-- Fix PL/pgSQL ambiguity between RETURNS TABLE(target_id ...) output
-- parameters and SQL columns named target_id. Publishing failed with:
-- "column reference \"target_id\" is ambiguous".

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
#variable_conflict use_column
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
      'pending'
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
      'pending',
      case when coalesce(p_as_draft, false) then 'infinity'::timestamptz else p_scheduled_at end
    from inserted
    where not coalesce(p_as_draft, false)
    -- Avoid bare "target_id": it conflicts with this function's RETURNS TABLE column.
    returning 1
  )
  select inserted.post_id, inserted.id, inserted.idempotency_key
  from inserted;
end;
$$;

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
#variable_conflict use_column
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

create or replace function public.claim_due_social_targets(
  claim_limit integer default 50,
  lease_seconds integer default 300
)
returns table(target_id uuid, idempotency_key uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
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
