-- Durable prepared batches are consumed only by the future named-agent cadence service.
alter table public.content_routine_runs add column prepared_output jsonb;
comment on column public.content_routine_runs.prepared_output is 'PreparedRoutineOutput v1: workspace/run/routine identity, result, and complete draft cards with canonical socialPostId. Preparation is not delivery.';

-- Preserve old configurations for explicit review; do not silently re-enable publication.
update public.content_routines
set enabled = false, next_run_at = null, schedule = schedule || jsonb_build_object('reviewReason',
  'Review this routine: choose X text, LinkedIn text, or Instagram carousel and save drafts for review before enabling.')
where schedule->>'outputMode' = 'schedule'
   or not (platforms <@ array['twitter','linkedin','instagram']::text[]);

create function public.guard_automatic_routine_formats() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.enabled and (new.schedule->>'outputMode' = 'schedule'
      or new.schedule ? 'reviewReason'
      or not (new.platforms <@ array['twitter','linkedin','instagram']::text[])) then
    raise exception 'Review this routine: choose X text, LinkedIn text, or Instagram carousel and save drafts for review before enabling.';
  end if;
  return new;
end; $$;
create trigger guard_automatic_routine_formats before insert or update on public.content_routines
for each row execute function public.guard_automatic_routine_formats();

-- Narrow compatibility repair: only starter payloads belonging to their onboarding session.
-- Preserve the original saved text, legacy formats, cards and retention timestamps.
update public.content_agent_messages m set payload = m.payload || '{"action":"draft"}'::jsonb
from public.onboarding_sessions s
where m.thread_id = s.thread_id and m.user_id = s.workspace_id and m.role = 'assistant'
  and not (m.payload ? 'action') and jsonb_typeof(m.payload->'cards') = 'array'
  and not exists (select 1 from jsonb_array_elements(m.payload->'cards') c
    where c->>'type' <> 'draft' or c->>'cardId' not like 'onboarding-%');

create or replace function public.apply_onboarding_preparation(p_workspace_id uuid, p_revision integer, p_content_profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.onboarding_sessions; b jsonb; item jsonb; idx integer := 0; start_y integer; thread uuid;
begin
  select * into s from public.onboarding_sessions where workspace_id = p_workspace_id for update;
  if not found or s.revision <> p_revision or s.approved_revision <> p_revision then
    raise exception 'Review the latest preparation before activating.';
  end if;
  if not public.bento_has_hosted_access(p_workspace_id) then
    raise exception 'Your trial is not verified yet. Your preparation is saved.';
  end if;
  if s.applied_revision = p_revision then return jsonb_build_object('threadId', s.thread_id); end if;
  if s.status <> 'prepared' or s.candidates is null then raise exception 'Preparation is not ready.'; end if;
  b := s.brief;
  -- Legacy saved messages remain readable; pending legacy candidates must be prepared again.
  -- Never infer a script or silently reinterpret an unstructured caption as a carousel.
  if exists (select 1 from jsonb_array_elements(s.candidates->'drafts') d
    where not (coalesce(d->>'platform', '') in ('twitter','linkedin') and coalesce(d->>'format', '') = 'post')
      and not (coalesce(d->>'platform', '') = 'instagram' and coalesce(d->>'format', '') = 'carousel'
        and case when jsonb_typeof(d->'slides') = 'array' then jsonb_array_length(d->'slides') between 2 and 10 else false end)) then
    raise exception 'Choose X text, LinkedIn text, or Instagram carousel and prepare supported structured starter drafts before activating. Your earlier preparation is saved.';
  end if;
  update public.profiles set username = b->>'username', display_name = b->>'displayName',
    bio = b->>'bio', avatar_url = nullif(b->>'avatarUrl', ''), account_timezone = b->>'timezone',
    accent_color = case b->>'style' when 'mint' then '#2d8e57' when 'rose' then '#b82f32' else '#3478f6' end,
    page_published = coalesce((b->>'publishPage')::boolean, false), onboarded = true, workspace_status = 'active', updated_at = now()
    where id = p_workspace_id;
  select coalesce(max(y + h), 0) into start_y from public.blocks where user_id = p_workspace_id and page_id is null;
  insert into public.blocks(user_id, type, content, w, h, x, y, position)
    values (p_workspace_id, 'note', jsonb_build_object('text', coalesce(nullif(b->>'bio', ''), 'Hi, I’m ' || (b->>'displayName') || '. Welcome to my page.'), 'tint', case when b->>'style' = 'blue' then 'sky' else b->>'style' end), 2, 2, 0, start_y, 0);
  for item in select value from jsonb_array_elements(b->'links') loop
    insert into public.blocks(user_id, type, content, w, h, x, y, position)
      values (p_workspace_id, 'generic_link', jsonb_build_object('title', item->>'title', 'url', item->>'url'),
        2, 1, 0, start_y + 2 + idx, idx + 1);
    idx := idx + 1;
  end loop;
  for item in select value from jsonb_array_elements(s.candidates->'brain') loop
    -- Never replace existing creator-edited or locked documents during optional adoption.
    if not exists (select 1 from public.creator_brain_items where user_id = p_workspace_id
      and kind = item->>'kind' and lower(title) = lower(item->>'title')) then
      insert into public.creator_brain_items(user_id, kind, title, content, provenance, status, locked, source_ref)
        values (p_workspace_id, item->>'kind', item->>'title', item->>'content', 'creator', 'confirmed', true,
          'onboarding:' || p_revision || ':' || (item->>'kind'));
    end if;
  end loop;
  insert into public.creator_content_profiles(user_id, goal, niche_keywords, language, region, timezone, platform_frequencies)
    values (p_workspace_id, p_content_profile->>'goal', array(select jsonb_array_elements_text(p_content_profile->'niche_keywords')),
      p_content_profile->>'language', p_content_profile->>'region', p_content_profile->>'timezone', p_content_profile->'platform_frequencies')
    on conflict (user_id) do nothing;
  insert into public.content_agent_threads(user_id, title) values (p_workspace_id, case when jsonb_array_length(s.candidates->'drafts') > 0 then 'Your first posts' else 'Your page and Brain' end) returning id into thread;
  insert into public.content_agent_messages(thread_id, user_id, role, content, payload)
    values (thread, p_workspace_id, 'assistant', case when jsonb_array_length(s.candidates->'drafts') > 0 then 'Your starting point is ready. Review these drafts and make them your own.' else 'Your page and Brain are ready. Create drafts in Agent when you are ready.' end,
      jsonb_build_object('action', case when jsonb_array_length(s.candidates->'drafts') > 0 then 'draft' else 'answer' end, 'message', case when jsonb_array_length(s.candidates->'drafts') > 0 then s.candidates->>'nextAction' else 'Your page and Brain are ready. Create drafts in Agent when you are ready.' end, 'cards', coalesce((
        select jsonb_agg(jsonb_build_object('type', 'draft', 'cardId', 'onboarding-' || ord,
          'platform', value->>'platform', 'format', value->>'format',
          'title', value->>'title', 'body', value->>'body', 'visualBrief', value->'visualBrief', 'sourceUrls', coalesce(value->'sourceUrls', '[]'::jsonb),
          'rationale', coalesce(value->>'rationale', 'A starter draft based on your approved audience, voice, and goal.'))
          || case when value ? 'slides' then jsonb_build_object('slides', value->'slides') else '{}'::jsonb end
          || case when value ? 'editorial' then jsonb_build_object('editorial', value->'editorial') else '{}'::jsonb end)
        from jsonb_array_elements(s.candidates->'drafts') with ordinality as drafts(value, ord)
      ), '[]'::jsonb)));
  update public.onboarding_sessions set status = 'applied', applied_revision = p_revision, step = 6,
    thread_id = thread, updated_at = now() where workspace_id = p_workspace_id;
  return jsonb_build_object('threadId', thread);
end; $$;
revoke all on function public.apply_onboarding_preparation(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.apply_onboarding_preparation(uuid, integer, jsonb) to service_role;

notify pgrst, 'reload schema';
