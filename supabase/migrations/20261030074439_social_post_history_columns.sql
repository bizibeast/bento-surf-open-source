begin;

-- A disconnected account is no longer usable for publishing, but its published
-- destinations and permalinks belong to the creator's post history.
alter table public.social_post_targets
  add column if not exists account_handle_snapshot text,
  add column if not exists account_display_name_snapshot text,
  add column if not exists provider_user_id_snapshot text;

-- Capture the identity and any exact imported permalink before an account can
-- disappear. The insights table itself is still deleted with the connection.
update public.social_post_targets target
set account_handle_snapshot = connection.provider_handle,
    account_display_name_snapshot = connection.provider_display_name,
    provider_user_id_snapshot = connection.provider_user_id,
    remote_post_url = coalesce(
      nullif(target.remote_post_url, ''),
      (
        select nullif(insight.remote_post_url, '')
        from public.social_content_insights insight
        where insight.connection_id = target.connection_id
          and insight.provider = target.provider
          and insight.remote_post_id = target.remote_post_id
          and nullif(insight.remote_post_url, '') is not null
        order by insight.fetched_at desc
        limit 1
      )
    )
from public.social_connections connection
where connection.id = target.connection_id;

commit;
