-- Provider-side media processing is asynchronous for Instagram, Threads, and
-- TikTok. Keep those targets in a first-class processing state until the
-- provider confirms the remote post, rather than reporting a false success.

alter table public.social_post_targets
  drop constraint social_post_targets_status_check,
  add constraint social_post_targets_status_check check (
    status in ('pending', 'queued', 'publishing', 'processing', 'published', 'retrying', 'failed', 'cancelled')
  );

alter table public.social_publish_attempts
  drop constraint social_publish_attempts_outcome_check,
  add constraint social_publish_attempts_outcome_check check (
    outcome in ('started', 'submitted', 'published', 'retrying', 'failed')
  );

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
      and target.status in ('pending', 'retrying', 'queued', 'processing')
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
