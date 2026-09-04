-- Keep a scheduled post and every selected destination in one transaction.
-- These functions are intentionally invoker-rights and service-role only: the
-- application has already authenticated the creator and validated provider
-- payloads before it reaches this persistence boundary.

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
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_post_id uuid;
  v_post_status text;
begin
  if p_user_id is null then
    raise exception 'A creator is required.' using errcode = '22023';
  end if;

  if p_scheduled_at is null then
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

    -- Once a provider has accepted a target, replacing all destinations could
    -- create a duplicate remote post. Keep the published history immutable.
    if exists (
      select 1
      from public.social_post_targets target
      where target.post_id = v_post_id
        and target.status in ('publishing', 'processing', 'published')
    ) then
      raise exception 'A post already sent to a social network cannot be edited.' using errcode = '55000';
    end if;

    update public.social_posts
    set body = p_body,
        title = nullif(p_title, ''),
        media = coalesce(p_media, '[]'::jsonb),
        scheduled_at = p_scheduled_at,
        timezone = coalesce(nullif(p_timezone, ''), 'UTC'),
        status = 'scheduled',
        published_at = null,
        cancelled_at = null
    where id = v_post_id;

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
      'scheduled'
    )
    returning id into v_post_id;
  end if;

  return query
  insert into public.social_post_targets (
    post_id,
    connection_id,
    provider,
    provider_settings,
    next_attempt_at
  )
  select
    v_post_id,
    (target.value ->> 'connectionId')::uuid,
    target.value ->> 'provider',
    coalesce(target.value -> 'providerSettings', '{}'::jsonb),
    p_scheduled_at
  from jsonb_array_elements(p_targets) target
  returning
    public.social_post_targets.post_id,
    public.social_post_targets.id,
    public.social_post_targets.idempotency_key;
end;
$$;

revoke all on function public.save_social_post_atomic(
  uuid, uuid, text, text, jsonb, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_social_post_atomic(
  uuid, uuid, text, text, jsonb, timestamptz, text, jsonb
) to service_role;

create or replace function public.cancel_social_post_atomic(
  p_user_id uuid,
  p_post_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_post_status text;
begin
  select post.status
  into v_post_status
  from public.social_posts post
  where post.id = p_post_id
    and post.user_id = p_user_id
  for update;

  if not found or v_post_status not in ('draft', 'scheduled', 'failed', 'partially_failed') then
    raise exception 'This post can no longer be cancelled.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.social_post_targets target
    where target.post_id = p_post_id
      and target.status in ('publishing', 'processing')
  ) then
    raise exception 'This post is already being processed by a social network.' using errcode = '55000';
  end if;

  update public.social_posts
  set status = 'cancelled',
      cancelled_at = now()
  where id = p_post_id;

  update public.social_post_targets
  set status = 'cancelled',
      lease_expires_at = null,
      next_attempt_at = null
  where post_id = p_post_id
    and status in ('pending', 'queued', 'retrying', 'failed');

  return true;
end;
$$;

revoke all on function public.cancel_social_post_atomic(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_social_post_atomic(uuid, uuid)
  to service_role;

-- A queue send is not the source of truth. If delivery fails, release the
-- target immediately so the minute-based scheduler can claim it again.
create or replace function public.release_social_target_claims(
  p_target_ids uuid[]
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_released integer;
begin
  update public.social_post_targets
  set status = case
        when remote_post_id is not null then 'processing'
        when attempt_count > 0 then 'retrying'
        else 'pending'
      end,
      lease_expires_at = null,
      next_attempt_at = coalesce(next_attempt_at, now())
  where id = any(coalesce(p_target_ids, '{}'::uuid[]))
    and status = 'queued';

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

revoke all on function public.release_social_target_claims(uuid[])
  from public, anon, authenticated;
grant execute on function public.release_social_target_claims(uuid[])
  to service_role;
