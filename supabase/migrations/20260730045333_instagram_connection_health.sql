-- Provider health is separate from the token lifecycle status. A token can be
-- active while required webhook subscriptions are missing, so the UI must not
-- present `status = active` as proof that Instagram Auto DMs are ready.
alter table public.social_connections
  add column if not exists connection_health text not null default 'action_required',
  add column if not exists webhook_fields text[] not null default '{}',
  add column if not exists last_verified_at timestamptz,
  add column if not exists last_webhook_at timestamptz,
  add column if not exists reauth_required boolean not null default false,
  add column if not exists provider_error_code text,
  add constraint social_connections_health_check check (
    connection_health in (
      'verifying',
      'healthy',
      'action_required',
      'expired',
      'revoked'
    )
  );

create index if not exists social_connections_health_idx
  on public.social_connections(user_id, provider, connection_health);

-- Existing Instagram rows predate subscription read-back. They remain usable
-- for non-automation features, but must be repaired and verified before an
-- automation can be enabled.
update public.social_connections
set
  connection_health = 'action_required',
  webhook_fields = '{}',
  last_verified_at = null,
  provider_error_code = null
where provider = 'instagram';

comment on column public.social_connections.connection_health is
  'Verified provider readiness; never inferred only from token presence.';
comment on column public.social_connections.webhook_fields is
  'Webhook fields read back from the provider subscribed_apps endpoint.';
comment on column public.social_connections.last_verified_at is
  'Last successful provider profile and webhook subscription verification.';
comment on column public.social_connections.last_webhook_at is
  'Last valid signed webhook received for this provider account.';
comment on column public.social_connections.reauth_required is
  'True when provider permissions or token state require a new OAuth grant.';

-- Align the durable event lease with the dedicated Cloudflare queue:
-- one initial delivery plus eight retries, and reclaim a processing event if
-- the prior Worker died after claiming it but before updating its status.
create or replace function public.claim_instagram_dm_event(
  p_external_event_id text,
  p_instagram_account_id text,
  p_event_type text,
  p_event_context text,
  p_source_id text,
  p_media_id text default null,
  p_sender_username text default null,
  p_sender_id_hash text default null,
  p_occurred_at timestamptz default null
)
returns table(event_id uuid, should_process boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  insert into public.instagram_dm_events (
    external_event_id, instagram_account_id, event_type, event_context,
    source_id, media_id, sender_username, sender_id_hash, occurred_at
  ) values (
    p_external_event_id, p_instagram_account_id, p_event_type, p_event_context,
    p_source_id, p_media_id, p_sender_username, p_sender_id_hash, p_occurred_at
  )
  on conflict (external_event_id) do nothing;

  update public.instagram_dm_events event
  set status = 'processing',
      attempt_count = event.attempt_count + 1,
      error_code = null,
      error_message = null,
      processed_at = null,
      updated_at = now()
  where event.external_event_id = p_external_event_id
    and event.attempt_count < 9
    and (
      event.status in ('received', 'failed')
      or (
        event.status = 'processing'
        and event.updated_at < now() - interval '20 seconds'
      )
    )
  returning event.id into claimed_id;

  if claimed_id is null then
    select event.id into claimed_id
    from public.instagram_dm_events event
    where event.external_event_id = p_external_event_id;
    return query select claimed_id, false;
  end if;

  return query select claimed_id, true;
end;
$$;

revoke all on function public.claim_instagram_dm_event(
  text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_event(
  text, text, text, text, text, text, text, text, timestamptz
) to service_role;

-- This table is intentionally service-role only. Repeat grants explicitly so
-- the migration remains correct under Supabase's 2026 Data API grant changes.
revoke all on public.social_connections from anon, authenticated;
grant all on public.social_connections to service_role;
