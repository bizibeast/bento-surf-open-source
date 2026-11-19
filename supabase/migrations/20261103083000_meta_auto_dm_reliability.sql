-- Keep recipient commands durable and ordered independently of the webhook send claim.
alter table public.meta_dm_recipient_preferences
  add column last_command_at timestamptz;

create table public.meta_dm_recipient_commands (
  provider text not null check (provider in ('instagram', 'facebook')),
  provider_user_id text not null,
  external_event_id text not null check (length(external_event_id) between 1 and 600),
  sender_id_hash text not null,
  command_at timestamptz not null,
  opted_out boolean not null,
  primary key (provider, provider_user_id, external_event_id)
);
alter table public.meta_dm_recipient_commands enable row level security;
revoke all on public.meta_dm_recipient_commands from public, anon, authenticated;
grant all on public.meta_dm_recipient_commands to service_role;

create function public.apply_meta_dm_recipient_command(
  p_provider text, p_provider_user_id text, p_sender_id_hash text,
  p_external_event_id text, p_occurred_at timestamptz, p_opted_out boolean
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_command_at timestamptz := least(coalesce(p_occurred_at, now()), now());
  v_last_command_at timestamptz;
  v_rows integer;
begin
  if p_provider not in ('instagram', 'facebook') or p_provider_user_id is null
    or length(coalesce(p_sender_id_hash, '')) < 16
    or length(coalesce(p_external_event_id, '')) not between 1 and 600
    or p_opted_out is null then
    raise exception 'Invalid Meta recipient command';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider || ':' || p_provider_user_id, 0));
  insert into public.meta_dm_recipient_commands
    (provider, provider_user_id, external_event_id, sender_id_hash, command_at, opted_out)
  values (p_provider, p_provider_user_id, p_external_event_id, p_sender_id_hash, v_command_at, p_opted_out)
  on conflict (provider, provider_user_id, external_event_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return 'duplicate'; end if;
  select last_command_at into v_last_command_at from public.meta_dm_recipient_preferences
    where provider = p_provider and provider_user_id = p_provider_user_id
      and sender_id_hash = p_sender_id_hash;
  -- A late old STOP or START must not reverse a newer instruction. STOP wins a tie.
  if v_last_command_at is null or v_command_at > v_last_command_at
    or (v_command_at = v_last_command_at and p_opted_out) then
    perform public.set_meta_dm_recipient_opt_out(
      p_provider, p_provider_user_id, p_sender_id_hash, p_opted_out
    );
    update public.meta_dm_recipient_preferences set last_command_at = v_command_at
      where provider = p_provider and provider_user_id = p_provider_user_id
        and sender_id_hash = p_sender_id_hash;
    return 'applied';
  end if;
  return 'stale';
end;
$$;
revoke all on function public.apply_meta_dm_recipient_command(text, text, text, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.apply_meta_dm_recipient_command(text, text, text, text, timestamptz, boolean)
  to service_role;

-- Account guards can already exist from opt-outs, with no rejection window yet.
create or replace function public.note_meta_dm_provider_rejection(
  p_provider text, p_provider_user_id text, p_code text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_provider not in ('instagram', 'facebook') or p_provider_user_id is null
    or p_code not in ('4', '17', '32', '429', '613') then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider || ':' || p_provider_user_id, 0));
  insert into public.meta_dm_account_guard
    (provider, provider_user_id, rejection_count, rejection_window_started_at)
  values (p_provider, p_provider_user_id, 1, now())
  on conflict (provider, provider_user_id) do update set
    rejection_count = case when meta_dm_account_guard.rejection_window_started_at is null
      or meta_dm_account_guard.rejection_window_started_at < now() - interval '1 hour'
      then 1 else meta_dm_account_guard.rejection_count + 1 end,
    rejection_window_started_at = case when meta_dm_account_guard.rejection_window_started_at is null
      or meta_dm_account_guard.rejection_window_started_at < now() - interval '1 hour'
      then now() else meta_dm_account_guard.rejection_window_started_at end,
    paused_until = case when meta_dm_account_guard.rejection_window_started_at >= now() - interval '1 hour'
      and meta_dm_account_guard.rejection_count >= 2
      then greatest(meta_dm_account_guard.paused_until, now() + interval '30 minutes')
      else meta_dm_account_guard.paused_until end,
    pause_reason = case when meta_dm_account_guard.rejection_window_started_at >= now() - interval '1 hour'
      and meta_dm_account_guard.rejection_count >= 2 then 'provider_rate_limit'
      else meta_dm_account_guard.pause_reason end,
    updated_at = now();
end;
$$;
revoke all on function public.note_meta_dm_provider_rejection(text, text, text)
  from public, anon, authenticated;
grant execute on function public.note_meta_dm_provider_rejection(text, text, text) to service_role;

-- Attach the owning connection at intake so safety skips appear in its activity list.
create function public.link_meta_dm_event_connection() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.connection_id is not null then return new; end if;
  if tg_table_name = 'instagram_dm_events' then
    select c.id into new.connection_id from public.social_connections c
      where c.provider = 'instagram' and c.provider_user_id = new.instagram_account_id;
  elsif tg_table_name = 'facebook_dm_events' then
    select c.id into new.connection_id from public.social_connections c
      where c.provider = 'facebook' and c.provider_user_id = new.facebook_page_id;
  end if;
  return new;
end;
$$;
create trigger link_instagram_dm_event_connection before insert on public.instagram_dm_events
  for each row execute function public.link_meta_dm_event_connection();
create trigger link_facebook_dm_event_connection before insert on public.facebook_dm_events
  for each row execute function public.link_meta_dm_event_connection();

update public.instagram_dm_events e set connection_id = c.id
  from public.social_connections c
  where e.connection_id is null and e.status = 'ignored'
    and e.error_code in ('recipient_preference_updated', 'recipient_opted_out',
      'recipient_cooldown', 'account_budget', 'account_paused', 'recipient_missing')
    and e.created_at > now() - interval '30 days'
    and c.provider = 'instagram' and c.provider_user_id = e.instagram_account_id;
update public.facebook_dm_events e set connection_id = c.id
  from public.social_connections c
  where e.connection_id is null and e.status = 'ignored'
    and e.error_code in ('recipient_preference_updated', 'recipient_opted_out',
      'recipient_cooldown', 'account_budget', 'account_paused', 'recipient_missing')
    and e.created_at > now() - interval '30 days'
    and c.provider = 'facebook' and c.provider_user_id = e.facebook_page_id;
