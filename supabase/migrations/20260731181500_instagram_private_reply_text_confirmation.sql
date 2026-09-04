-- Instagram comment private replies are text-only. Follow-up messages become
-- available only after the recipient responds. That first response opens the
-- 24-hour messaging window, after which Bento sends the configured native
-- quick-reply button and waits for its signed payload before delivery.
alter table public.instagram_dm_runs
  add column if not exists quick_reply_prompt_response_id text,
  add column if not exists recipient_replied_at timestamptz;

create or replace function public.claim_instagram_dm_run_for_quick_reply_prompt(
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
  claimed_run public.instagram_dm_runs%rowtype;
  normalized_reply text := trim(coalesce(p_reply_text, ''));
begin
  if p_sender_id_hash is null
    or length(p_sender_id_hash) < 16
    or length(normalized_reply) not between 1 and 2000
  then
    return query select null::uuid, null::uuid, null::uuid, false;
    return;
  end if;

  update public.instagram_dm_runs run
  set status = 'expired', updated_at = now()
  where run.connection_id = p_connection_id
    and run.sender_id_hash = p_sender_id_hash
    and run.status = 'awaiting_confirmation'
    and run.action_expires_at <= now();

  with candidate as (
    select run.id
    from public.instagram_dm_runs run
    join public.instagram_dm_automations automation
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
  update public.instagram_dm_runs run
  set
    status = 'delivering',
    confirmation_event_id = p_confirmation_event_id,
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

  return query
    select claimed_run.id, claimed_run.automation_id, claimed_run.user_id, true;
end;
$$;

revoke all on function public.claim_instagram_dm_run_for_quick_reply_prompt(
  uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.claim_instagram_dm_run_for_quick_reply_prompt(
  uuid, text, uuid, text
) to service_role;

comment on function public.claim_instagram_dm_run_for_quick_reply_prompt(uuid, text, uuid, text) is
  'Claims a sender-bound pending Instagram run so Bento can send a signed native quick reply after the recipient opens Meta''s messaging window.';
