-- Opening-message flows span two independent Meta webhook deliveries. Persist
-- that state so a quick reply can only advance the exact sender's active run,
-- once, even when Cloudflare Queues redelivers a message.
create table if not exists public.instagram_dm_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.instagram_dm_automations(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  trigger_event_id uuid not null unique references public.instagram_dm_events(id) on delete cascade,
  confirmation_event_id uuid unique references public.instagram_dm_events(id) on delete set null,
  sender_id_hash text not null,
  sender_username text,
  status text not null default 'awaiting_confirmation',
  attempt_count integer not null default 0,
  action_expires_at timestamptz not null default (now() + interval '24 hours'),
  opening_response_id text,
  final_response_id text,
  error_code text,
  error_message text,
  processing_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_dm_runs_status_check check (
    status in ('awaiting_confirmation', 'delivering', 'completed', 'failed', 'expired')
  ),
  constraint instagram_dm_runs_attempt_count_check check (
    attempt_count between 0 and 9
  ),
  constraint instagram_dm_runs_sender_hash_check check (
    length(sender_id_hash) between 16 and 128
  ),
  constraint instagram_dm_runs_error_length_check check (
    error_message is null or length(error_message) <= 500
  )
);

create index if not exists instagram_dm_runs_sender_state_idx
  on public.instagram_dm_runs(connection_id, sender_id_hash, status, action_expires_at);

create index if not exists instagram_dm_runs_user_created_idx
  on public.instagram_dm_runs(user_id, created_at desc);

alter table public.instagram_dm_runs enable row level security;

revoke all on public.instagram_dm_runs from public, anon, authenticated;
grant all on public.instagram_dm_runs to service_role;

comment on table public.instagram_dm_runs is
  'Service-only state for multi-webhook Instagram Auto-DM workflows. Raw Instagram sender IDs and action secrets are never stored.';
comment on column public.instagram_dm_runs.sender_id_hash is
  'HMAC-derived sender binding; the raw Instagram sender ID remains ephemeral.';
comment on column public.instagram_dm_runs.action_expires_at is
  'Confirmation actions expire inside Meta''s response window.';

create or replace function public.create_instagram_dm_run(
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

  insert into public.instagram_dm_runs (
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
  from public.instagram_dm_automations automation
  where automation.id = p_automation_id
    and automation.connection_id = p_connection_id
    and automation.user_id = p_user_id
    and automation.enabled = true
  on conflict (trigger_event_id) do nothing
  returning id into created_run_id;

  if created_run_id is null then
    select run.id into created_run_id
    from public.instagram_dm_runs run
    where run.trigger_event_id = p_trigger_event_id
      and run.automation_id = p_automation_id
      and run.connection_id = p_connection_id
      and run.user_id = p_user_id
      and run.sender_id_hash = p_sender_id_hash;
  end if;

  return created_run_id;
end;
$$;

revoke all on function public.create_instagram_dm_run(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.create_instagram_dm_run(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

-- Atomically bind a quick reply to the connection, sender and event that
-- delivered it. A stale queue worker may reclaim the same event after its
-- lease, but a different event or sender cannot consume the run.
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
            and run.processing_started_at < now() - interval '20 seconds'
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
