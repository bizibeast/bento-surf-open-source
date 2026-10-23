-- Processing time starts when the provider receives media, never at draft creation.
alter table public.social_post_targets
  add column processing_started_at timestamptz,
  add column failure_notification_pending boolean not null default false;

-- Backfill timestamps only from recorded submissions in the current retry cycle.
-- Existing failures are not automatically resent or emailed by this migration.
update public.social_post_targets target
set processing_started_at = (
  select min(attempt.created_at) from public.social_publish_attempts attempt
  where attempt.target_id = target.id and attempt.outcome = 'submitted'
    and attempt.created_at >= coalesce(target.retry_started_at, '-infinity'::timestamptz)
)
where target.remote_post_id is not null
  and target.provider in ('instagram', 'threads', 'tiktok')
  and target.status <> 'published';

create index social_target_pending_failure_email_idx
  on public.social_post_targets(updated_at)
  where failure_notification_pending and status = 'failed';

create or replace function public.retry_failed_social_post_atomic(
  p_user_id uuid,
  p_post_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_count integer;
begin
  select post.status into v_status
  from public.social_posts post
  where post.id = p_post_id and post.user_id = p_user_id
  for update;

  if not found or v_status not in ('failed', 'partially_failed', 'publishing') then
    raise exception 'This post has no failed destinations to retry.' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.social_post_targets target
    join public.social_connections connection on connection.id = target.connection_id
    where target.post_id = p_post_id
      and target.status = 'failed'
      and (
        connection.user_id <> p_user_id
        or connection.status <> 'active'
        or coalesce(connection.reauth_required, false)
        or (target.provider = 'instagram' and not (
          'instagram_business_content_publish' = any(connection.scopes)
        ))
      )
  ) then
    raise exception 'Reconnect the failed destinations before retrying this post.' using errcode = '55000';
  end if;

  with retried as (
    update public.social_post_targets target
    set status = 'pending',
        attempt_count = 0,
        next_attempt_at = now(),
        lease_expires_at = null,
        idempotency_key = gen_random_uuid(),
        last_error_code = null,
        last_error_message = null,
        retry_started_at = now(),
        processing_started_at = null,
        failure_notification_pending = false,
        -- Definite container failures never created a post. Keep all ambiguous IDs.
        remote_post_id = case
          when target.provider in ('instagram', 'threads')
            and target.last_error_code in ('container_error', 'container_expired') then null
          else target.remote_post_id end
    where target.post_id = p_post_id and target.status = 'failed'
    returning target.id, target.idempotency_key, target.provider
  ), queued as (
    insert into public.social_outbox_events (
      target_id, idempotency_key, provider, event_type, payload, status, available_at
    )
    select
      retried.id,
      retried.idempotency_key,
      retried.provider,
      'publish',
      jsonb_build_object(
        'targetId', retried.id,
        'idempotencyKey', retried.idempotency_key,
        'provider', retried.provider
      ),
      'pending',
      now()
    from retried
    on conflict (target_id, event_type) do update
      set idempotency_key = excluded.idempotency_key,
          payload = excluded.payload,
          status = 'pending',
          available_at = excluded.available_at,
          claimed_at = null,
          delivered_at = null,
          last_error = null,
          attempt_count = 0
    returning 1
  )
  select count(*)::integer into v_count from queued;

  if v_count = 0 then
    raise exception 'This post has no failed destinations to retry.' using errcode = '55000';
  end if;

  update public.social_posts
  set status = 'publishing',
      scheduled_at = least(coalesce(scheduled_at, now()), now()),
      cancelled_at = null
  where id = p_post_id;

  return v_count;
end;
$$;

revoke all on function public.retry_failed_social_post_atomic(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.retry_failed_social_post_atomic(uuid, uuid)
  to service_role;

-- Invoked only by the corrected Worker; applying this migration never restarts uploads.
create or replace function public.recover_interrupted_social_targets()
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  -- Wait beyond the longest provider call before recovering an abandoned worker.
  -- Only YouTube has a persisted resumable upload that proves replay is safe.
  with interrupted as (
    select target.id
    from public.social_post_targets target
    join public.social_posts post on post.id = target.post_id
    where post.status in ('scheduled', 'publishing', 'partially_failed')
    and post.cancelled_at is null
    and target.status = 'publishing'
    and target.lease_expires_at < now() - interval '15 minutes'
    and target.updated_at < now() - interval '15 minutes'
    order by target.updated_at for update of target skip locked limit 100
  )
  update public.social_post_targets target
  set status = case
        when target.provider = 'youtube'
          and (target.upload_session_url is not null or target.remote_post_id is not null)
          then 'retrying' else 'outcome_unknown' end,
      next_attempt_at = case
        when target.provider = 'youtube'
          and (target.upload_session_url is not null or target.remote_post_id is not null)
          then now() else null end,
      lease_expires_at = null,
      last_error_code = case when target.provider = 'youtube'
        and (target.upload_session_url is not null or target.remote_post_id is not null)
        then 'upload_interrupted' else 'outcome_unknown' end,
      last_error_message = case when target.provider = 'youtube'
        and (target.upload_session_url is not null or target.remote_post_id is not null)
        then 'The upload was interrupted. Bento will check and resume the existing upload.'
        else 'The provider has not confirmed the result. Check your profile before retrying to avoid a duplicate post.' end
  from interrupted
  where target.id = interrupted.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.recover_interrupted_social_targets() from public, anon, authenticated;
grant execute on function public.recover_interrupted_social_targets() to service_role;

create or replace function public.claim_due_social_targets(
  claim_limit integer default 50,
  lease_seconds integer default 300
)
returns table(target_id uuid, idempotency_key uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
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
      and (target.status in ('pending', 'retrying', 'queued', 'processing')
        or (target.status = 'outcome_unknown' and target.provider = 'youtube'
          and target.next_attempt_at is not null
          and target.last_error_code is distinct from 'upload_session_expired'
          and (target.upload_session_url is not null or target.remote_post_id is not null)))
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
revoke all on function public.claim_due_social_targets(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_due_social_targets(integer, integer) to service_role;
