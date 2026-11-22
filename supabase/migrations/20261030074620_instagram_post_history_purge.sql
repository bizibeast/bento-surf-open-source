begin;

-- The private provider ID is retained solely to honor a later Meta deletion
-- request for an Instagram account that was already disconnected.
revoke all on public.social_post_targets from anon, authenticated;
comment on column public.social_post_targets.provider_user_id_snapshot is
  'Service-only account identifier for a later provider data deletion request; never return to clients.';

create or replace function public.purge_instagram_account_data(
  p_provider_user_id text,
  p_provider_user_id_hash text,
  p_confirmation_code uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  deletion_completed_at timestamptz := now();
begin
  if p_provider_user_id is null
    or length(trim(p_provider_user_id)) < 1
    or length(p_provider_user_id) > 255
    or p_provider_user_id_hash is null
    or length(p_provider_user_id_hash) < 32
    or length(p_provider_user_id_hash) > 128
    or p_confirmation_code is null
  then
    raise exception 'Invalid Instagram data deletion request';
  end if;

  -- Historical events can outlive a connection because their foreign key is
  -- intentionally ON DELETE SET NULL for normal disconnect diagnostics. A
  -- Meta deletion request has stricter semantics, so remove both currently
  -- connected and already-detached events for this Instagram account.
  delete from public.instagram_dm_events event
  where event.instagram_account_id = p_provider_user_id
    or event.connection_id in (
      select connection.id
      from public.social_connections connection
      where connection.provider = 'instagram'
        and connection.provider_user_id = p_provider_user_id
    );

  -- A normal disconnect preserves published destinations. Meta's signed data
  -- deletion request must also purge targets detached by an earlier disconnect.
  delete from public.social_post_targets target
  where target.provider = 'instagram'
    and (
      target.provider_user_id_snapshot = p_provider_user_id
      or target.connection_id in (
        select connection.id
        from public.social_connections connection
        where connection.provider = 'instagram'
          and connection.provider_user_id = p_provider_user_id
      )
    );

  -- This cascades to account automations and any remaining workflow runs.
  delete from public.social_connections connection
  where connection.provider = 'instagram'
    and connection.provider_user_id = p_provider_user_id;

  insert into public.instagram_data_deletion_requests (
    confirmation_code,
    provider_user_id_hash,
    completed_at,
    expires_at
  )
  values (
    p_confirmation_code,
    p_provider_user_id_hash,
    deletion_completed_at,
    deletion_completed_at + interval '30 days'
  )
  on conflict (confirmation_code) do update
  set
    provider_user_id_hash = excluded.provider_user_id_hash,
    completed_at = excluded.completed_at,
    expires_at = excluded.expires_at;

  return deletion_completed_at;
end;
$$;

revoke all on function public.purge_instagram_account_data(
  text, text, uuid
) from public, anon, authenticated;
grant execute on function public.purge_instagram_account_data(
  text, text, uuid
) to service_role;

commit;
