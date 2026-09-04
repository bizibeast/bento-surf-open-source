-- A PL/pgSQL `return query` appends rows but does not exit the function.
-- The duplicate-event branch previously emitted `(event_id, false)` and then
-- fell through to emit `(event_id, true)`. The Worker consumed the first row,
-- so duplicate delivery remained suppressed, but the RPC contract was
-- ambiguous for every other caller. Return immediately after the rejected
-- claim so every invocation produces exactly one decision row.

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
    return;
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

comment on function public.claim_instagram_dm_event(
  text, text, text, text, text, text, text, text, timestamptz
) is 'Atomically claims one Instagram event and always returns exactly one decision row.';
