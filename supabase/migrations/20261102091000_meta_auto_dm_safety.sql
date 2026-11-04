-- Product safety ceilings, not Meta-published rate limits. All decisions are atomic per account.
create table public.meta_dm_recipient_preferences (
  provider text not null check (provider in ('instagram', 'facebook')),
  provider_user_id text not null,
  sender_id_hash text not null,
  opted_out_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (provider, provider_user_id, sender_id_hash)
);

create table public.meta_dm_send_claims (
  provider text not null check (provider in ('instagram', 'facebook')),
  provider_user_id text not null,
  event_id uuid not null,
  sender_id_hash text not null,
  automation_id uuid not null,
  event_type text not null check (event_type in ('comment', 'message')),
  outbound_count integer not null check (outbound_count between 1 and 2),
  claimed_at timestamptz not null default now(),
  primary key (provider, provider_user_id, event_id)
);
create index meta_dm_send_claims_recipient_idx on public.meta_dm_send_claims
  (provider, provider_user_id, sender_id_hash, automation_id, claimed_at desc);
create index meta_dm_send_claims_account_idx on public.meta_dm_send_claims
  (provider, provider_user_id, claimed_at desc);

create table public.meta_dm_account_guard (
  provider text not null check (provider in ('instagram', 'facebook')),
  provider_user_id text not null,
  rejection_count integer not null default 0,
  rejection_window_started_at timestamptz,
  paused_until timestamptz,
  pause_reason text,
  updated_at timestamptz not null default now(),
  primary key (provider, provider_user_id)
);

alter table public.meta_dm_recipient_preferences enable row level security;
alter table public.meta_dm_send_claims enable row level security;
alter table public.meta_dm_account_guard enable row level security;
revoke all on public.meta_dm_recipient_preferences, public.meta_dm_send_claims, public.meta_dm_account_guard from public, anon, authenticated;
grant all on public.meta_dm_recipient_preferences, public.meta_dm_send_claims, public.meta_dm_account_guard to service_role;

create or replace function public.set_meta_dm_recipient_opt_out(
  p_provider text, p_provider_user_id text, p_sender_id_hash text, p_opted_out boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_provider not in ('instagram', 'facebook') or p_provider_user_id is null
    or length(coalesce(p_sender_id_hash, '')) < 16 then
    raise exception 'Invalid Meta recipient';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider || ':' || p_provider_user_id, 0));
  insert into public.meta_dm_recipient_preferences
    (provider, provider_user_id, sender_id_hash, opted_out_at)
  values (p_provider, p_provider_user_id, p_sender_id_hash,
    case when p_opted_out then now() else null end)
  on conflict (provider, provider_user_id, sender_id_hash) do update
    set opted_out_at = excluded.opted_out_at, updated_at = now();
  -- A rising opt-out rate is a complaint proxy, not a Meta-published limit.
  if p_opted_out and (
    select coalesce(sum(c.outbound_count), 0) from public.meta_dm_send_claims c
    where c.provider = p_provider and c.provider_user_id = p_provider_user_id
      and c.claimed_at > now() - interval '1 hour'
  ) >= 20 and (
    select count(*) from public.meta_dm_recipient_preferences r
    where r.provider = p_provider and r.provider_user_id = p_provider_user_id
      and r.opted_out_at > now() - interval '1 hour'
  ) >= 3 and (
    select count(*) * 10 from public.meta_dm_recipient_preferences r
    where r.provider = p_provider and r.provider_user_id = p_provider_user_id
      and r.opted_out_at > now() - interval '1 hour'
  ) >= (
    select coalesce(sum(c.outbound_count), 0) from public.meta_dm_send_claims c
    where c.provider = p_provider and c.provider_user_id = p_provider_user_id
      and c.claimed_at > now() - interval '1 hour'
  ) then
    insert into public.meta_dm_account_guard (provider, provider_user_id, paused_until, pause_reason)
    values (p_provider, p_provider_user_id, now() + interval '1 hour', 'rising_opt_outs')
    on conflict (provider, provider_user_id) do update set
      paused_until = greatest(meta_dm_account_guard.paused_until, excluded.paused_until),
      pause_reason = 'rising_opt_outs', updated_at = now();
  end if;
end;
$$;

create or replace function public.claim_meta_dm_send(
  p_provider text, p_provider_user_id text, p_sender_id_hash text,
  p_event_id uuid, p_automation_id uuid, p_event_type text, p_outbound_count integer default 1
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_paused_until timestamptz;
  v_minute_count integer;
  v_day_count integer;
begin
  if p_provider not in ('instagram', 'facebook') or p_event_type not in ('comment', 'message')
    or p_provider_user_id is null or p_event_id is null or p_automation_id is null
    or length(coalesce(p_sender_id_hash, '')) < 16 or p_outbound_count not between 1 and 2 then
    return 'recipient_missing';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider || ':' || p_provider_user_id, 0));
  if exists (select 1 from public.meta_dm_recipient_preferences r where r.provider = p_provider
    and r.provider_user_id = p_provider_user_id and r.sender_id_hash = p_sender_id_hash
    and r.opted_out_at is not null) then
    return 'recipient_opted_out';
  end if;
  select paused_until into v_paused_until from public.meta_dm_account_guard g
    where g.provider = p_provider and g.provider_user_id = p_provider_user_id;
  if v_paused_until > v_now then return 'account_paused'; end if;
  -- A redelivered event keeps its original reservation and never consumes a second slot.
  if exists (select 1 from public.meta_dm_send_claims c where c.provider = p_provider
    and c.provider_user_id = p_provider_user_id and c.event_id = p_event_id) then
    return 'allowed';
  end if;
  -- A repeated comment on the same campaign does not trigger another private reply.
  if p_event_type = 'comment' and exists (
    select 1 from public.meta_dm_send_claims c where c.provider = p_provider
      and c.provider_user_id = p_provider_user_id and c.sender_id_hash = p_sender_id_hash
      and c.automation_id = p_automation_id and c.event_type = 'comment'
      and c.claimed_at > v_now - interval '24 hours'
  ) then return 'recipient_cooldown'; end if;
  select coalesce(sum(c.outbound_count), 0)::integer into v_minute_count
    from public.meta_dm_send_claims c where c.provider = p_provider
      and c.provider_user_id = p_provider_user_id and c.claimed_at > v_now - interval '1 minute';
  select coalesce(sum(c.outbound_count), 0)::integer into v_day_count
    from public.meta_dm_send_claims c where c.provider = p_provider
      and c.provider_user_id = p_provider_user_id and c.claimed_at > v_now - interval '24 hours';
  -- Reserve some account capacity for direct DMs and follow-ups during comment spikes.
  if v_minute_count + p_outbound_count > 20 or v_day_count + p_outbound_count > 250
    or (p_event_type = 'comment' and (v_minute_count + p_outbound_count > 15
      or v_day_count + p_outbound_count > 200))
  then return 'account_budget'; end if;
  insert into public.meta_dm_send_claims
    (provider, provider_user_id, event_id, sender_id_hash, automation_id, event_type, outbound_count, claimed_at)
  values (p_provider, p_provider_user_id, p_event_id, p_sender_id_hash, p_automation_id, p_event_type, p_outbound_count, v_now);
  delete from public.meta_dm_send_claims c where c.provider = p_provider
    and c.provider_user_id = p_provider_user_id and c.claimed_at < v_now - interval '8 days';
  return 'allowed';
end;
$$;

create or replace function public.note_meta_dm_provider_rejection(
  p_provider text, p_provider_user_id text, p_code text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_provider not in ('instagram', 'facebook') or p_provider_user_id is null
    or p_code not in ('4', '17', '32', '429', '613') then return; end if;
  insert into public.meta_dm_account_guard
    (provider, provider_user_id, rejection_count, rejection_window_started_at)
  values (p_provider, p_provider_user_id, 1, now())
  on conflict (provider, provider_user_id) do update set
    rejection_count = case when meta_dm_account_guard.rejection_window_started_at < now() - interval '1 hour'
      then 1 else meta_dm_account_guard.rejection_count + 1 end,
    rejection_window_started_at = case when meta_dm_account_guard.rejection_window_started_at < now() - interval '1 hour'
      then now() else meta_dm_account_guard.rejection_window_started_at end,
    paused_until = case when meta_dm_account_guard.rejection_window_started_at >= now() - interval '1 hour'
      and meta_dm_account_guard.rejection_count >= 2 then greatest(meta_dm_account_guard.paused_until, now() + interval '30 minutes')
      else meta_dm_account_guard.paused_until end,
    pause_reason = case when meta_dm_account_guard.rejection_window_started_at >= now() - interval '1 hour'
      and meta_dm_account_guard.rejection_count >= 2 then 'provider_rate_limit'
      else meta_dm_account_guard.pause_reason end,
    updated_at = now();
end;
$$;

revoke all on function public.set_meta_dm_recipient_opt_out(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.claim_meta_dm_send(text, text, text, uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.note_meta_dm_provider_rejection(text, text, text) from public, anon, authenticated;
grant execute on function public.set_meta_dm_recipient_opt_out(text, text, text, boolean) to service_role;
grant execute on function public.claim_meta_dm_send(text, text, text, uuid, uuid, text, integer) to service_role;
grant execute on function public.note_meta_dm_provider_rejection(text, text, text) to service_role;
