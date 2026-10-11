-- Retry only failed destinations. Keep published targets and their remote IDs intact.
alter table public.social_post_targets
  add column retry_started_at timestamptz;

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

  if not found or v_status not in ('failed', 'partially_failed') then
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
        retry_started_at = now()
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
