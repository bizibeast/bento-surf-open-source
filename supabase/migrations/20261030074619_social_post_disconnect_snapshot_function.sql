begin;

create or replace function private.preserve_social_post_history_on_disconnect()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A published target keeps its exact provider, account and post URL. A
  -- not-yet-published target must stop trying to use the deleted credential.
  update public.social_post_targets target
  set account_handle_snapshot = old.provider_handle,
      account_display_name_snapshot = old.provider_display_name,
      provider_user_id_snapshot = old.provider_user_id,
      remote_post_url = coalesce(
        nullif(target.remote_post_url, ''),
        (
          select nullif(insight.remote_post_url, '')
          from public.social_content_insights insight
          where insight.connection_id = old.id
            and insight.provider = target.provider
            and insight.remote_post_id = target.remote_post_id
            and nullif(insight.remote_post_url, '') is not null
          order by insight.fetched_at desc
          limit 1
        )
      )
  where target.connection_id = old.id;

  update public.social_post_targets target
  set status = 'failed',
      next_attempt_at = null,
      lease_expires_at = null,
      last_error_code = 'account_disconnected',
      last_error_message = 'The connected account was removed before this destination finished publishing.'
  where target.connection_id = old.id
    and target.status in ('pending', 'queued', 'publishing', 'processing', 'retrying', 'outcome_unknown');

  update public.social_repost_jobs job
  set phase = 'failed',
      next_attempt_at = null,
      lease_expires_at = null,
      last_error_message = 'The connected account was removed before this repost or its removal finished.'
  where job.target_id in (
    select target.id from public.social_post_targets target where target.connection_id = old.id
  )
    and job.phase not in ('removed', 'complete', 'failed');

  update public.social_posts post
  set status = case
    when exists (
      select 1 from public.social_post_targets target
      where target.post_id = post.id and target.status = 'published'
    ) then 'partially_failed'
    else 'failed'
  end
  where post.id in (
    select target.post_id from public.social_post_targets target where target.connection_id = old.id
  )
    and post.status in ('scheduled', 'publishing', 'partially_failed')
    and exists (
      select 1 from public.social_post_targets target
      where target.post_id = post.id and target.status = 'failed'
    )
    and not exists (
      select 1 from public.social_post_targets target
      where target.post_id = post.id
        and target.status in ('pending', 'queued', 'publishing', 'processing', 'retrying', 'outcome_unknown')
    );

  return old;
end;
$$;
revoke all on function private.preserve_social_post_history_on_disconnect()
  from public, anon, authenticated;

commit;
