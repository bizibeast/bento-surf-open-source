-- Creator-owned Facebook Page comment-to-DM and inbound-keyword automations.
-- Message bodies are processed ephemerally by the Worker and are not retained.

create table public.facebook_dm_automations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  name text not null,
  trigger_type text not null,
  keywords text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  match_type text not null default 'contains',
  media_scope text not null default 'any',
  media_ids text[] not null default '{}',
  reply_message text not null,
  public_reply_enabled boolean not null default false,
  public_reply_message text,
  public_reply_messages text[] not null default '{}',
  opening_message text,
  confirmation_button_label text,
  email_capture_enabled boolean not null default false,
  email_prompt_message text,
  email_marketing_consent_enabled boolean not null default false,
  reply_button_label text,
  reply_button_url text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_dm_automations_name_length check (length(name) between 1 and 80),
  constraint facebook_dm_automations_trigger_check check (
    trigger_type in ('comment_keyword', 'any_comment', 'dm_keyword', 'any_dm')
  ),
  constraint facebook_dm_automations_match_check check (match_type in ('contains', 'exact')),
  constraint facebook_dm_automations_keywords_count check (
    cardinality(keywords) <= 20 and octet_length(keywords::text) <= 4000
  ),
  constraint facebook_dm_automations_excluded_keywords_count check (
    cardinality(excluded_keywords) <= 20 and octet_length(excluded_keywords::text) <= 4000
  ),
  constraint facebook_dm_automations_keywords_required check (
    trigger_type in ('any_comment', 'any_dm') or cardinality(keywords) > 0
  ),
  constraint facebook_dm_automations_media_count check (
    cardinality(media_ids) <= 100 and octet_length(media_ids::text) <= 30000
  ),
  constraint facebook_dm_automations_media_scope_check check (
    media_scope in ('any', 'specific', 'future')
    and (media_scope <> 'specific' or cardinality(media_ids) > 0)
  ),
  constraint facebook_dm_automations_reply_length check (length(reply_message) between 1 and 1000),
  constraint facebook_dm_automations_public_replies_check check (
    cardinality(public_reply_messages) <= 3
    and octet_length(public_reply_messages::text) <= 2000
    and (
      (not public_reply_enabled and cardinality(public_reply_messages) = 0)
      or (public_reply_enabled and cardinality(public_reply_messages) > 0)
    )
  ),
  constraint facebook_dm_automations_opening_flow_check check (
    (opening_message is null and confirmation_button_label is null)
    or (
      length(opening_message) between 1 and 1000
      and length(confirmation_button_label) between 1 and 20
    )
  ),
  constraint facebook_dm_automations_email_prompt_check check (
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
  ),
  constraint facebook_dm_automations_reply_button_check check (
    (reply_button_label is null and reply_button_url is null)
    or (
      length(reply_button_label) between 1 and 20
      and length(reply_button_url) between 8 and 2048
      and reply_button_url ~ '^https://'
    )
  )
);

create index facebook_dm_automations_owner_idx
  on public.facebook_dm_automations(user_id, created_at desc);
create index facebook_dm_automations_connection_enabled_idx
  on public.facebook_dm_automations(connection_id, enabled, created_at);

create table public.facebook_dm_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  facebook_page_id text not null,
  connection_id uuid references public.social_connections(id) on delete set null,
  automation_id uuid references public.facebook_dm_automations(id) on delete set null,
  event_type text not null,
  event_context text not null default 'dm',
  source_id text not null,
  media_id text,
  sender_username text,
  sender_id_hash text,
  matched_keyword text,
  status text not null default 'received',
  attempt_count integer not null default 0,
  response_id text,
  public_reply_id text,
  error_code text,
  error_message text,
  occurred_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_dm_events_type_check check (event_type in ('comment', 'message')),
  constraint facebook_dm_events_context_check check (
    event_context in ('comment', 'dm', 'quick_reply')
  ),
  constraint facebook_dm_events_status_check check (
    status in ('received', 'processing', 'sent', 'ignored', 'failed')
  ),
  constraint facebook_dm_events_attempts_check check (attempt_count between 0 and 10),
  constraint facebook_dm_events_external_id_length check (length(external_event_id) between 1 and 600),
  constraint facebook_dm_events_account_length check (length(facebook_page_id) between 1 and 255),
  constraint facebook_dm_events_source_length check (length(source_id) between 1 and 255)
);

create index facebook_dm_events_connection_created_idx
  on public.facebook_dm_events(connection_id, created_at desc);
create index facebook_dm_events_automation_created_idx
  on public.facebook_dm_events(automation_id, created_at desc);
create index facebook_dm_events_status_created_idx
  on public.facebook_dm_events(status, created_at desc);

create table public.facebook_dm_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.facebook_dm_automations(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  trigger_event_id uuid not null unique references public.facebook_dm_events(id) on delete cascade,
  confirmation_event_id uuid unique references public.facebook_dm_events(id) on delete set null,
  email_event_id uuid unique references public.facebook_dm_events(id) on delete set null,
  sender_id_hash text not null,
  sender_username text,
  status text not null default 'awaiting_confirmation',
  attempt_count integer not null default 0,
  action_expires_at timestamptz not null default (now() + interval '24 hours'),
  opening_response_id text,
  quick_reply_prompt_response_id text,
  recipient_replied_at timestamptz,
  email_prompt_response_id text,
  captured_email text,
  audience_contact_id uuid references public.audience_contacts(id) on delete set null,
  final_response_id text,
  error_code text,
  error_message text,
  processing_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_dm_runs_status_check check (
    status in (
      'awaiting_confirmation',
      'awaiting_email',
      'delivering',
      'completed',
      'failed',
      'expired'
    )
  ),
  constraint facebook_dm_runs_attempt_count_check check (attempt_count between 0 and 9),
  constraint facebook_dm_runs_sender_hash_check check (length(sender_id_hash) between 16 and 128),
  constraint facebook_dm_runs_error_length_check check (
    error_message is null or length(error_message) <= 500
  ),
  constraint facebook_dm_runs_captured_email_check check (
    captured_email is null
    or (
      length(captured_email) between 3 and 254
      and captured_email = lower(trim(captured_email))
    )
  )
);

create index facebook_dm_runs_sender_state_idx
  on public.facebook_dm_runs(connection_id, sender_id_hash, status, action_expires_at);
create index facebook_dm_runs_user_created_idx
  on public.facebook_dm_runs(user_id, created_at desc);
create index facebook_dm_runs_email_state_idx
  on public.facebook_dm_runs(connection_id, sender_id_hash, created_at desc)
  where status in ('awaiting_email', 'delivering', 'failed');
create index facebook_dm_runs_automation_idx on public.facebook_dm_runs(automation_id);
create index facebook_dm_runs_connection_idx on public.facebook_dm_runs(connection_id);

create table public.facebook_delivery_slots (
  connection_id uuid primary key references public.social_connections(id) on delete cascade,
  next_available_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.facebook_dm_automations enable row level security;
alter table public.facebook_dm_events enable row level security;
alter table public.facebook_dm_runs enable row level security;
alter table public.facebook_delivery_slots enable row level security;

revoke all on public.facebook_dm_automations from public, anon, authenticated;
revoke all on public.facebook_dm_events from public, anon, authenticated;
revoke all on public.facebook_dm_runs from public, anon, authenticated;
revoke all on public.facebook_delivery_slots from public, anon, authenticated;
grant all on public.facebook_dm_automations to service_role;
grant all on public.facebook_dm_events to service_role;
grant all on public.facebook_dm_runs to service_role;
grant all on public.facebook_delivery_slots to service_role;

create trigger facebook_dm_automations_updated_at
  before update on public.facebook_dm_automations
  for each row execute function public.tg_set_updated_at();

create trigger facebook_dm_events_updated_at
  before update on public.facebook_dm_events
  for each row execute function public.tg_set_updated_at();

create trigger facebook_dm_runs_updated_at
  before update on public.facebook_dm_runs
  for each row execute function public.tg_set_updated_at();

comment on table public.facebook_dm_runs is
  'Service-only state for multi-webhook Facebook Auto-DM workflows. Raw Facebook sender IDs and action secrets are never stored.';
comment on column public.facebook_dm_runs.sender_id_hash is
  'HMAC-derived sender binding; the raw Facebook sender ID remains ephemeral.';

create or replace function public.claim_facebook_dm_event(
  p_external_event_id text,
  p_facebook_page_id text,
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
  insert into public.facebook_dm_events (
    external_event_id, facebook_page_id, event_type, event_context,
    source_id, media_id, sender_username, sender_id_hash, occurred_at
  ) values (
    p_external_event_id, p_facebook_page_id, p_event_type, p_event_context,
    p_source_id, p_media_id, p_sender_username, p_sender_id_hash, p_occurred_at
  )
  on conflict (external_event_id) do nothing;

  update public.facebook_dm_events event
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
    from public.facebook_dm_events event
    where event.external_event_id = p_external_event_id;
    return query select claimed_id, false;
    return;
  end if;

  return query select claimed_id, true;
end;
$$;

revoke all on function public.claim_facebook_dm_event(
  text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_facebook_dm_event(
  text, text, text, text, text, text, text, text, timestamptz
) to service_role;

create or replace function public.create_facebook_dm_run(
  p_automation_id uuid,
  p_connection_id uuid,
  p_user_id uuid,
  p_trigger_event_id uuid,
  p_sender_id_hash text,
  p_sender_username text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_run_id uuid;
begin
  if p_sender_id_hash is null or length(p_sender_id_hash) < 16 then
    return null;
  end if;

  insert into public.facebook_dm_runs (
    automation_id,
    connection_id,
    user_id,
    trigger_event_id,
    sender_id_hash,
    sender_username
  )
  select
    automation.id,
    automation.connection_id,
    automation.user_id,
    p_trigger_event_id,
    p_sender_id_hash,
    left(nullif(trim(p_sender_username), ''), 80)
  from public.facebook_dm_automations automation
  where automation.id = p_automation_id
    and automation.connection_id = p_connection_id
    and automation.user_id = p_user_id
    and automation.enabled = true
  on conflict (trigger_event_id) do nothing
  returning id into created_run_id;

  if created_run_id is null then
    select run.id into created_run_id
    from public.facebook_dm_runs run
    where run.trigger_event_id = p_trigger_event_id
      and run.automation_id = p_automation_id
      and run.connection_id = p_connection_id
      and run.user_id = p_user_id
      and run.sender_id_hash = p_sender_id_hash;
  end if;

  return created_run_id;
end;
$$;

revoke all on function public.create_facebook_dm_run(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.create_facebook_dm_run(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

create or replace function public.claim_facebook_dm_run(
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
  claimed_run public.facebook_dm_runs%rowtype;
begin
  update public.facebook_dm_runs run
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
            and run.processing_started_at < now() - interval '20 seconds'
          )
        )
      )
    )
  returning run.* into claimed_run;

  if claimed_run.id is null then
    update public.facebook_dm_runs
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

revoke all on function public.claim_facebook_dm_run(
  uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.claim_facebook_dm_run(
  uuid, uuid, text, uuid
) to service_role;

create or replace function public.claim_facebook_dm_run_for_quick_reply_prompt(
  p_connection_id uuid,
  p_sender_id_hash text,
  p_confirmation_event_id uuid,
  p_reply_text text
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
  claimed_run public.facebook_dm_runs%rowtype;
  normalized_reply text := trim(coalesce(p_reply_text, ''));
begin
  if p_sender_id_hash is null
    or length(p_sender_id_hash) < 16
    or length(normalized_reply) not between 1 and 2000
  then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  update public.facebook_dm_runs run
  set status = 'expired', updated_at = now()
  where run.connection_id = p_connection_id
    and run.sender_id_hash = p_sender_id_hash
    and run.status = 'awaiting_confirmation'
    and run.action_expires_at <= now();

  with candidate as (
    select run.id
    from public.facebook_dm_runs run
    join public.facebook_dm_automations automation
      on automation.id = run.automation_id
     and automation.connection_id = run.connection_id
    where run.connection_id = p_connection_id
      and run.sender_id_hash = p_sender_id_hash
      and run.action_expires_at > now()
      and run.attempt_count < 9
      and automation.enabled = true
      and automation.confirmation_button_label is not null
      and run.quick_reply_prompt_response_id is null
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
    order by run.created_at desc
    limit 1
    for update of run skip locked
  )
  update public.facebook_dm_runs run
  set
    status = 'delivering',
    confirmation_event_id = p_confirmation_event_id,
    attempt_count = run.attempt_count + 1,
    processing_started_at = now(),
    error_code = null,
    error_message = null,
    updated_at = now()
  from candidate
  where run.id = candidate.id
  returning run.* into claimed_run;

  if claimed_run.id is null then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  return query
    select claimed_run.id, claimed_run.automation_id, claimed_run.user_id, true;
end;
$$;

revoke all on function public.claim_facebook_dm_run_for_quick_reply_prompt(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.claim_facebook_dm_run_for_quick_reply_prompt(
  uuid, text, uuid, text
) to service_role;

create or replace function public.claim_facebook_dm_email_run(
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
  claimed_run public.facebook_dm_runs%rowtype;
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
    from public.facebook_dm_runs run
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
  update public.facebook_dm_runs run
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
    update public.facebook_dm_runs
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

revoke all on function public.claim_facebook_dm_email_run(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.claim_facebook_dm_email_run(
  uuid, text, uuid, text
) to service_role;

create or replace function public.capture_facebook_dm_email_audience(
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
  run_row public.facebook_dm_runs%rowtype;
  contact_row_id uuid;
  normalized_email text := lower(trim(coalesce(p_email, '')));
begin
  select run.* into run_row
  from public.facebook_dm_runs run
  where run.id = p_run_id
    and run.status = 'delivering'
    and run.captured_email = normalized_email
  for update;

  if run_row.id is null then
    raise exception 'Facebook email workflow is not deliverable';
  end if;

  contact_row_id := public.commerce_upsert_audience_contact(
    run_row.user_id,
    normalized_email,
    null,
    'facebook_auto_dm',
    now()
  );

  update public.audience_contacts
  set
    marketing_consent = marketing_consent or coalesce(p_marketing_consent, false),
    metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
      'facebook_page_name', left(nullif(trim(p_sender_username), ''), 80),
      'facebook_automation_id', run_row.automation_id,
      'facebook_connection_id', run_row.connection_id
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
    'facebook_email_captured',
    'facebook_auto_dm',
    run_row.id,
    'facebook-auto-dm:' || run_row.id::text || ':email',
    jsonb_build_object(
      'automation_id', run_row.automation_id,
      'connection_id', run_row.connection_id,
      'marketing_consent', coalesce(p_marketing_consent, false)
    ),
    now()
  )
  on conflict (creator_id, dedupe_key) do nothing;

  update public.facebook_dm_runs
  set audience_contact_id = contact_row_id, updated_at = now()
  where id = run_row.id;

  return contact_row_id;
end;
$$;

revoke all on function public.capture_facebook_dm_email_audience(
  uuid, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.capture_facebook_dm_email_audience(
  uuid, text, text, boolean
) to service_role;

create or replace function public.claim_facebook_delivery_slot(
  p_connection_id uuid,
  p_min_interval_ms integer default 500
)
returns table(wait_ms integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  current_next timestamptz;
  bounded_interval_ms integer := greatest(100, least(coalesce(p_min_interval_ms, 500), 5000));
begin
  if not exists (
    select 1
    from public.social_connections connection
    where connection.id = p_connection_id
      and connection.provider = 'facebook'
  ) then
    raise exception 'Facebook connection does not exist';
  end if;

  insert into public.facebook_delivery_slots (connection_id)
  values (p_connection_id)
  on conflict (connection_id) do nothing;

  select slot.next_available_at
  into current_next
  from public.facebook_delivery_slots slot
  where slot.connection_id = p_connection_id
  for update;

  if current_next > v_now then
    return query
      select greatest(
        1,
        ceil(extract(epoch from (current_next - v_now)) * 1000)::integer
      );
    return;
  end if;

  update public.facebook_delivery_slots slot
  set
    next_available_at = v_now + make_interval(secs => bounded_interval_ms / 1000.0),
    last_attempt_at = v_now,
    updated_at = v_now
  where slot.connection_id = p_connection_id;

  return query select 0;
end;
$$;

revoke all on function public.claim_facebook_delivery_slot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_facebook_delivery_slot(uuid, integer)
  to service_role;

create or replace function public.defer_facebook_delivery_slot(
  p_connection_id uuid,
  p_retry_after_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  bounded_delay_seconds integer := greatest(
    1,
    least(coalesce(p_retry_after_seconds, 60), 3600)
  );
begin
  insert into public.facebook_delivery_slots (
    connection_id,
    next_available_at,
    updated_at
  )
  select
    connection.id,
    v_now + make_interval(secs => bounded_delay_seconds),
    v_now
  from public.social_connections connection
  where connection.id = p_connection_id
    and connection.provider = 'facebook'
  on conflict (connection_id) do update
  set
    next_available_at = greatest(
      public.facebook_delivery_slots.next_available_at,
      excluded.next_available_at
    ),
    updated_at = v_now;
end;
$$;

revoke all on function public.defer_facebook_delivery_slot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.defer_facebook_delivery_slot(uuid, integer)
  to service_role;
