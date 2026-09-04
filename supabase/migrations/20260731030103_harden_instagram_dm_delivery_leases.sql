-- A Meta Graph API request may legitimately consume the full 20-second
-- application timeout, followed by database and analytics writes. The prior
-- 20-second stale-processing lease could therefore let a duplicate webhook
-- delivery reclaim the same event while the first Worker was still sending.
--
-- Use a two-minute crash-recovery lease for the event and both durable
-- workflow claim paths. Explicit failures remain immediately retryable; only
-- abandoned "processing" / "delivering" claims wait for the lease.

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
        and event.updated_at < now() - interval '2 minutes'
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

create or replace function public.claim_instagram_dm_run(
  p_run_id uuid,
  p_connection_id uuid,
  p_sender_id_hash text,
  p_confirmation_event_id uuid
)
returns table(
  run_id uuid,
  automation_id uuid,
  user_id uuid,
  should_process boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run public.instagram_dm_runs%rowtype;
begin
  update public.instagram_dm_runs run
  set
    status = 'delivering',
    confirmation_event_id = p_confirmation_event_id,
    attempt_count = run.attempt_count + 1,
    processing_started_at = now(),
    error_code = null,
    error_message = null,
    updated_at = now()
  where run.id = p_run_id
    and run.connection_id = p_connection_id
    and run.sender_id_hash = p_sender_id_hash
    and run.action_expires_at > now()
    and run.attempt_count < 9
    and (
      run.status = 'awaiting_confirmation'
      or (
        run.confirmation_event_id = p_confirmation_event_id
        and (
          run.status = 'failed'
          or (
            run.status = 'delivering'
            and run.processing_started_at < now() - interval '2 minutes'
          )
        )
      )
    )
  returning run.* into claimed_run;

  if claimed_run.id is null then
    update public.instagram_dm_runs
    set status = 'expired', updated_at = now()
    where id = p_run_id
      and connection_id = p_connection_id
      and sender_id_hash = p_sender_id_hash
      and status = 'awaiting_confirmation'
      and action_expires_at <= now();

    return query
      select p_run_id, null::uuid, null::uuid, false;
    return;
  end if;

  return query
    select claimed_run.id, claimed_run.automation_id, claimed_run.user_id, true;
end;
$$;

revoke all on function public.claim_instagram_dm_run(
  uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_run(
  uuid, uuid, text, uuid
) to service_role;

create or replace function public.claim_instagram_dm_email_run(
  p_connection_id uuid,
  p_sender_id_hash text,
  p_email_event_id uuid,
  p_email text
)
returns table(
  run_id uuid,
  automation_id uuid,
  user_id uuid,
  should_process boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run public.instagram_dm_runs%rowtype;
  normalized_email text := lower(trim(coalesce(p_email, '')));
begin
  if p_sender_id_hash is null
    or length(p_sender_id_hash) < 16
    or length(normalized_email) not between 3 and 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  with candidate as (
    select run.id
    from public.instagram_dm_runs run
    where run.connection_id = p_connection_id
      and run.sender_id_hash = p_sender_id_hash
      and run.action_expires_at > now()
      and run.attempt_count < 9
      and (
        run.status = 'awaiting_email'
        or (
          run.email_event_id = p_email_event_id
          and (
            run.status = 'failed'
            or (
              run.status = 'delivering'
              and run.processing_started_at < now() - interval '2 minutes'
            )
          )
        )
      )
    order by run.created_at desc
    limit 1
    for update skip locked
  )
  update public.instagram_dm_runs run
  set
    status = 'delivering',
    email_event_id = p_email_event_id,
    captured_email = normalized_email,
    attempt_count = run.attempt_count + 1,
    processing_started_at = now(),
    error_code = null,
    error_message = null,
    updated_at = now()
  from candidate
  where run.id = candidate.id
  returning run.* into claimed_run;

  if claimed_run.id is null then
    update public.instagram_dm_runs
    set status = 'expired', updated_at = now()
    where connection_id = p_connection_id
      and sender_id_hash = p_sender_id_hash
      and status = 'awaiting_email'
      and action_expires_at <= now();

    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  return query
    select claimed_run.id, claimed_run.automation_id, claimed_run.user_id, true;
end;
$$;

revoke all on function public.claim_instagram_dm_email_run(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_email_run(
  uuid, text, uuid, text
) to service_role;
