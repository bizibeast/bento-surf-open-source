-- Meta requires a verifiable deletion status URL. Keep only a short-lived,
-- non-reversible account hash and the completion timestamp; the Instagram
-- account ID, access token, automations, event history and workflow runs are
-- removed atomically.
create table public.instagram_data_deletion_requests (
  confirmation_code uuid primary key,
  provider_user_id_hash text not null,
  completed_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint instagram_data_deletion_hash_check check (
    length(provider_user_id_hash) between 32 and 128
  ),
  constraint instagram_data_deletion_expiry_check check (
    expires_at > completed_at
  )
);

create index instagram_data_deletion_expiry_idx
  on public.instagram_data_deletion_requests(expires_at);

alter table public.instagram_data_deletion_requests enable row level security;

revoke all on public.instagram_data_deletion_requests from public, anon, authenticated;
grant all on public.instagram_data_deletion_requests to service_role;

comment on table public.instagram_data_deletion_requests is
  'Service-only, short-lived proof that a Meta Instagram data deletion request completed. No raw provider identifier is retained.';

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

create or replace function public.get_instagram_data_deletion_status(
  p_confirmation_code uuid
)
returns table(completed_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select request.completed_at
  from public.instagram_data_deletion_requests request
  where request.confirmation_code = p_confirmation_code
    and request.expires_at > now()
  limit 1;
$$;

revoke all on function public.get_instagram_data_deletion_status(
  uuid
) from public, anon, authenticated;
grant execute on function public.get_instagram_data_deletion_status(
  uuid
) to service_role;
