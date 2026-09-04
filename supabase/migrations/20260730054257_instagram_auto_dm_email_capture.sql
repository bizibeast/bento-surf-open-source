-- Optional, consent-aware email capture for Instagram Auto-DM workflows.
-- The sender remains bound by an HMAC hash; raw Instagram sender IDs are
-- transient and never persisted.

alter table public.instagram_dm_automations
  add column if not exists email_capture_enabled boolean not null default false,
  add column if not exists email_prompt_message text,
  add column if not exists email_marketing_consent_enabled boolean not null default false;

alter table public.instagram_dm_automations
  add constraint instagram_dm_automations_email_prompt_check
  check (
    (
      email_capture_enabled = false
      and email_prompt_message is null
      and email_marketing_consent_enabled = false
    )
    or (
      email_capture_enabled = true
      and email_prompt_message is not null
      and length(trim(email_prompt_message)) between 1 and 700
      and opening_message is not null
      and confirmation_button_label is not null
    )
  );

alter table public.instagram_dm_runs
  add column if not exists email_event_id uuid unique
    references public.instagram_dm_events(id) on delete set null,
  add column if not exists captured_email text,
  add column if not exists email_prompt_response_id text,
  add column if not exists audience_contact_id uuid
    references public.audience_contacts(id) on delete set null;

alter table public.instagram_dm_runs
  drop constraint if exists instagram_dm_runs_status_check;

alter table public.instagram_dm_runs
  add constraint instagram_dm_runs_status_check check (
    status in (
      'awaiting_confirmation',
      'awaiting_email',
      'delivering',
      'completed',
      'failed',
      'expired'
    )
  ),
  add constraint instagram_dm_runs_captured_email_check check (
    captured_email is null
    or (
      length(captured_email) between 3 and 254
      and captured_email = lower(trim(captured_email))
    )
  );

create index if not exists instagram_dm_runs_email_state_idx
  on public.instagram_dm_runs(connection_id, sender_id_hash, created_at desc)
  where status in ('awaiting_email', 'delivering', 'failed');

-- Claim the newest active email-capture run for this exact Instagram account
-- and sender. The same webhook event may reclaim a stale/failed delivery, but
-- another event cannot consume a run already bound to a submitted email.
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
              and run.processing_started_at < now() - interval '20 seconds'
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

-- Normalize the captured address into the creator's unified Audience and
-- append one idempotent source event. Marketing consent is only elevated when
-- the automation displayed Bento's fixed consent disclosure before the reply.
create or replace function public.capture_instagram_dm_email_audience(
  p_run_id uuid,
  p_email text,
  p_sender_username text,
  p_marketing_consent boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  run_row public.instagram_dm_runs%rowtype;
  contact_row_id uuid;
  normalized_email text := lower(trim(coalesce(p_email, '')));
begin
  select run.* into run_row
  from public.instagram_dm_runs run
  where run.id = p_run_id
    and run.status = 'delivering'
    and run.captured_email = normalized_email
  for update;

  if run_row.id is null then
    raise exception 'Instagram email workflow is not deliverable';
  end if;

  contact_row_id := public.commerce_upsert_audience_contact(
    run_row.user_id,
    normalized_email,
    null,
    'instagram_auto_dm',
    now()
  );

  update public.audience_contacts
  set
    marketing_consent = marketing_consent or coalesce(p_marketing_consent, false),
    metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
      'instagram_handle', left(nullif(trim(p_sender_username), ''), 80),
      'instagram_automation_id', run_row.automation_id,
      'instagram_connection_id', run_row.connection_id
    )),
    updated_at = now()
  where id = contact_row_id
    and creator_id = run_row.user_id;

  insert into public.audience_events(
    creator_id,
    contact_id,
    event_type,
    source_type,
    source_id,
    dedupe_key,
    metadata,
    occurred_at
  )
  values (
    run_row.user_id,
    contact_row_id,
    'instagram_email_captured',
    'instagram_auto_dm',
    run_row.id,
    'instagram-auto-dm:' || run_row.id::text || ':email',
    jsonb_build_object(
      'automation_id', run_row.automation_id,
      'connection_id', run_row.connection_id,
      'marketing_consent', coalesce(p_marketing_consent, false)
    ),
    now()
  )
  on conflict (creator_id, dedupe_key) do nothing;

  update public.instagram_dm_runs
  set audience_contact_id = contact_row_id, updated_at = now()
  where id = run_row.id;

  return contact_row_id;
end;
$$;

revoke all on function public.capture_instagram_dm_email_audience(
  uuid, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.capture_instagram_dm_email_audience(
  uuid, text, text, boolean
) to service_role;

comment on column public.instagram_dm_automations.email_capture_enabled is
  'When enabled, a confirmed workflow asks the sender to reply with an email before delivering the final response.';
comment on column public.instagram_dm_automations.email_marketing_consent_enabled is
  'Records marketing consent only when the fixed disclosure shown by Bento is included in the email prompt.';
