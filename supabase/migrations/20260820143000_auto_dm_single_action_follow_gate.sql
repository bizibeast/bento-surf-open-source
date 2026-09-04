-- Comment Auto-DMs always use one sender-bound action. Instagram can then
-- verify follow status before email capture/final delivery.

do $migration$
declare
  follow_gate_already_present boolean := exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'instagram_dm_automations'
      and column_name = 'follow_gate_enabled'
  );
begin
  alter table public.instagram_dm_automations
    add column if not exists follow_gate_enabled boolean not null default false,
    add column if not exists follow_prompt_message text not null default 'Follow this account, then tap I’ve followed.',
    add column if not exists follow_max_rechecks integer not null default 3,
    add column if not exists follow_fail_action text not null default 'send_anyway';

  update public.instagram_dm_automations
  set opening_message = coalesce(opening_message, 'Thanks for your comment! I have it ready for you.'),
      confirmation_button_label = coalesce(confirmation_button_label, 'Send it'),
      follow_gate_enabled = case when follow_gate_already_present then follow_gate_enabled else true end
  where trigger_type in ('comment_keyword', 'any_comment');
end;
$migration$;

alter table public.instagram_dm_automations
  drop constraint if exists instagram_dm_automations_comment_action_check,
  drop constraint if exists instagram_dm_automations_follow_gate_check;

alter table public.instagram_dm_automations
  add constraint instagram_dm_automations_comment_action_check check (
    trigger_type not in ('comment_keyword', 'any_comment')
    or (opening_message is not null and confirmation_button_label is not null)
  ),
  add constraint instagram_dm_automations_follow_gate_check check (
    follow_max_rechecks between 1 and 3
    and follow_fail_action in ('send_anyway', 'withhold')
    and length(trim(follow_prompt_message)) between 1 and 700
    and (follow_gate_enabled = false or trigger_type in ('comment_keyword', 'any_comment'))
  );

update public.facebook_dm_automations
set opening_message = coalesce(opening_message, 'Thanks for your comment! I have it ready for you.'),
    confirmation_button_label = coalesce(confirmation_button_label, 'Send it')
where trigger_type in ('comment_keyword', 'any_comment');

alter table public.facebook_dm_automations
  drop constraint if exists facebook_dm_automations_comment_action_check;

alter table public.facebook_dm_automations
  add constraint facebook_dm_automations_comment_action_check check (
    trigger_type not in ('comment_keyword', 'any_comment')
    or (opening_message is not null and confirmation_button_label is not null)
  );

alter table public.instagram_dm_runs
  add column if not exists follow_gate_enabled boolean not null default false,
  add column if not exists follow_prompt_message text not null default 'Follow this account, then tap I’ve followed.',
  add column if not exists follow_max_rechecks integer not null default 3,
  add column if not exists follow_fail_action text not null default 'send_anyway',
  add column if not exists follow_recheck_count integer not null default 0,
  add column if not exists follow_event_id uuid unique references public.instagram_dm_events(id) on delete set null,
  add column if not exists follow_prompt_response_id text,
  add column if not exists follow_verified_at timestamptz;

alter table public.instagram_dm_runs
  drop constraint if exists instagram_dm_runs_status_check,
  drop constraint if exists instagram_dm_runs_follow_check;

alter table public.instagram_dm_runs
  add constraint instagram_dm_runs_status_check check (
    status in (
      'awaiting_confirmation', 'awaiting_follow', 'awaiting_email', 'delivering',
      'completed', 'blocked', 'failed', 'expired'
    )
  ),
  add constraint instagram_dm_runs_follow_check check (
    follow_max_rechecks between 1 and 3
    and follow_recheck_count between 0 and follow_max_rechecks
    and follow_fail_action in ('send_anyway', 'withhold')
    and length(trim(follow_prompt_message)) between 1 and 700
  );

create index if not exists instagram_dm_runs_follow_state_idx
  on public.instagram_dm_runs(connection_id, sender_id_hash, created_at desc)
  where status = 'awaiting_follow';

create or replace function public.create_instagram_dm_run(
  p_automation_id uuid,
  p_connection_id uuid,
  p_user_id uuid,
  p_trigger_event_id uuid,
  p_sender_id_hash text,
  p_sender_username text default null
) returns uuid
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
    automation_id, connection_id, user_id, trigger_event_id, sender_id_hash,
    sender_username, follow_gate_enabled, follow_prompt_message,
    follow_max_rechecks, follow_fail_action
  )
  select
    automation.id, automation.connection_id, automation.user_id, p_trigger_event_id,
    p_sender_id_hash, left(nullif(trim(p_sender_username), ''), 80),
    automation.follow_gate_enabled, automation.follow_prompt_message,
    automation.follow_max_rechecks, automation.follow_fail_action
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

revoke all on function public.create_instagram_dm_run(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_instagram_dm_run(uuid, uuid, uuid, uuid, text, text)
  to service_role;

create or replace function public.claim_instagram_dm_follow_recheck(
  p_run_id uuid,
  p_connection_id uuid,
  p_sender_id_hash text,
  p_follow_event_id uuid
) returns table(
  run_id uuid,
  automation_id uuid,
  user_id uuid,
  follow_recheck_count integer,
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
  set status = 'delivering',
      follow_event_id = p_follow_event_id,
      follow_recheck_count = case
        when run.follow_event_id = p_follow_event_id then run.follow_recheck_count
        else run.follow_recheck_count + 1
      end,
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
      (run.status = 'awaiting_follow' and run.follow_recheck_count < run.follow_max_rechecks)
      or (
        run.follow_event_id = p_follow_event_id
        and (
          run.status = 'failed'
          or (run.status = 'delivering' and run.processing_started_at < now() - interval '2 minutes')
        )
      )
    )
  returning run.* into claimed_run;

  if claimed_run.id is null then
    return query select p_run_id, null::uuid, null::uuid, 0, false;
    return;
  end if;

  return query select
    claimed_run.id,
    claimed_run.automation_id,
    claimed_run.user_id,
    claimed_run.follow_recheck_count,
    true;
end;
$$;

revoke all on function public.claim_instagram_dm_follow_recheck(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_follow_recheck(uuid, uuid, text, uuid)
  to service_role;

create or replace function public.claim_instagram_dm_run_for_quick_reply_prompt(
  p_connection_id uuid,
  p_sender_id_hash text,
  p_confirmation_event_id uuid,
  p_reply_text text
) returns table(run_id uuid, automation_id uuid, user_id uuid, should_process boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run public.instagram_dm_runs%rowtype;
begin
  if p_sender_id_hash is null or length(p_sender_id_hash) < 16 then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  with candidate as (
    select run.id
    from public.instagram_dm_runs run
    join public.instagram_dm_automations automation on automation.id = run.automation_id
    where run.connection_id = p_connection_id
      and run.sender_id_hash = p_sender_id_hash
      and run.status = 'awaiting_confirmation'
      and run.action_expires_at > now()
      and run.attempt_count < 9
      and automation.enabled = true
      and lower(trim(p_reply_text)) = lower(trim(automation.confirmation_button_label))
    order by run.created_at desc
    limit 1
    for update of run skip locked
  )
  update public.instagram_dm_runs run
  set status = 'delivering',
      confirmation_event_id = p_confirmation_event_id,
      recipient_replied_at = now(),
      attempt_count = run.attempt_count + 1,
      processing_started_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  where run.id = (select candidate.id from candidate)
  returning run.* into claimed_run;

  if claimed_run.id is null then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  return query select claimed_run.id, claimed_run.automation_id, claimed_run.user_id, true;
end;
$$;

revoke all on function public.claim_instagram_dm_run_for_quick_reply_prompt(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_run_for_quick_reply_prompt(uuid, text, uuid, text)
  to service_role;

create or replace function public.claim_facebook_dm_run_for_quick_reply_prompt(
  p_connection_id uuid,
  p_sender_id_hash text,
  p_confirmation_event_id uuid,
  p_reply_text text
) returns table(run_id uuid, automation_id uuid, user_id uuid, should_process boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run public.facebook_dm_runs%rowtype;
begin
  if p_sender_id_hash is null or length(p_sender_id_hash) < 16 then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  with candidate as (
    select run.id
    from public.facebook_dm_runs run
    join public.facebook_dm_automations automation on automation.id = run.automation_id
    where run.connection_id = p_connection_id
      and run.sender_id_hash = p_sender_id_hash
      and run.status = 'awaiting_confirmation'
      and run.action_expires_at > now()
      and run.attempt_count < 9
      and automation.enabled = true
      and lower(trim(p_reply_text)) = lower(trim(automation.confirmation_button_label))
    order by run.created_at desc
    limit 1
    for update of run skip locked
  )
  update public.facebook_dm_runs run
  set status = 'delivering',
      confirmation_event_id = p_confirmation_event_id,
      recipient_replied_at = now(),
      attempt_count = run.attempt_count + 1,
      processing_started_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  where run.id = (select candidate.id from candidate)
  returning run.* into claimed_run;

  if claimed_run.id is null then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  return query select claimed_run.id, claimed_run.automation_id, claimed_run.user_id, true;
end;
$$;

revoke all on function public.claim_facebook_dm_run_for_quick_reply_prompt(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_facebook_dm_run_for_quick_reply_prompt(uuid, text, uuid, text)
  to service_role;
