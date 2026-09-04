-- Expand Auto-DM into a multi-trigger flow builder while keeping existing
-- automations compatible. Message contents still remain ephemeral.

create unique index if not exists social_connections_instagram_account_unique_idx
  on public.social_connections(provider, provider_user_id)
  where provider = 'instagram';

alter table public.instagram_dm_automations
  drop constraint if exists instagram_dm_automations_trigger_check,
  drop constraint if exists instagram_dm_automations_keywords_required,
  drop constraint if exists instagram_dm_automations_public_reply;

alter table public.instagram_dm_automations
  add column if not exists excluded_keywords text[] not null default '{}',
  add column if not exists media_scope text not null default 'any',
  add column if not exists public_reply_messages text[] not null default '{}',
  add column if not exists opening_message text,
  add column if not exists confirmation_button_label text,
  add column if not exists reply_button_label text,
  add column if not exists reply_button_url text;

update public.instagram_dm_automations
set public_reply_messages = array[public_reply_message]
where public_reply_enabled
  and public_reply_message is not null
  and cardinality(public_reply_messages) = 0;

update public.instagram_dm_automations
set media_scope = case when cardinality(media_ids) > 0 then 'specific' else 'any' end;

alter table public.instagram_dm_automations
  add constraint instagram_dm_automations_trigger_check check (
    trigger_type in (
      'comment_keyword', 'any_comment', 'dm_keyword', 'any_dm',
      'story_reply_keyword', 'any_story_reply',
      'live_comment_keyword', 'any_live_comment', 'post_share'
    )
  ),
  add constraint instagram_dm_automations_keywords_required check (
    trigger_type in ('any_comment', 'any_dm', 'any_story_reply', 'any_live_comment', 'post_share')
    or cardinality(keywords) > 0
  ),
  add constraint instagram_dm_automations_excluded_keywords_count check (
    cardinality(excluded_keywords) <= 20 and octet_length(excluded_keywords::text) <= 4000
  ),
  add constraint instagram_dm_automations_media_scope_check check (
    media_scope in ('any', 'specific', 'future')
    and (media_scope <> 'specific' or cardinality(media_ids) > 0)
  ),
  add constraint instagram_dm_automations_public_replies_check check (
    cardinality(public_reply_messages) <= 3
    and octet_length(public_reply_messages::text) <= 2000
    and (
      (not public_reply_enabled and cardinality(public_reply_messages) = 0)
      or (public_reply_enabled and cardinality(public_reply_messages) > 0)
    )
  ),
  add constraint instagram_dm_automations_opening_flow_check check (
    (opening_message is null and confirmation_button_label is null)
    or (
      length(opening_message) between 1 and 1000
      and length(confirmation_button_label) between 1 and 20
    )
  ),
  add constraint instagram_dm_automations_reply_button_check check (
    (reply_button_label is null and reply_button_url is null)
    or (
      length(reply_button_label) between 1 and 20
      and length(reply_button_url) between 8 and 2048
      and reply_button_url ~ '^https://'
    )
  );

alter table public.instagram_dm_events
  add column if not exists event_context text not null default 'dm';

update public.instagram_dm_events
set event_context = case when event_type = 'comment' then 'comment' else 'dm' end;

alter table public.instagram_dm_events
  add constraint instagram_dm_events_context_check check (
    event_context in ('comment', 'live_comment', 'dm', 'story_reply', 'post_share', 'quick_reply')
  );

drop function if exists public.claim_instagram_dm_event(
  text, text, text, text, text, text, text, timestamptz
);

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
set search_path = public
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
      updated_at = now()
  where event.external_event_id = p_external_event_id
    and event.status in ('received', 'failed')
    and event.attempt_count < 5
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
