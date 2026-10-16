alter table public.profiles add column if not exists page_published boolean not null default true;
alter table public.profiles alter column page_published set default false;

create table public.onboarding_sessions (
  workspace_id uuid primary key references public.profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  flow_version integer not null default 1,
  revision integer not null default 0,
  step integer not null default 0 check (step between 0 and 6),
  brief jsonb not null default '{}'::jsonb,
  candidates jsonb,
  approved_revision integer,
  applied_revision integer,
  status text not null default 'draft' check (status in ('draft', 'prepared', 'applied')),
  generation_count integer not null default 0 check (generation_count between 0 and 2),
  job_status text not null default 'idle' check (job_status in ('idle', 'queued', 'running', 'ready', 'failed')),
  job_attempts integer not null default 0,
  job_lease uuid,
  job_lease_until timestamptz,
  job_error text,
  thread_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(brief) = 'object'),
  check (octet_length(brief::text) < 32000),
  check (candidates is null or octet_length(candidates::text) < 100000)
);
alter table public.onboarding_sessions enable row level security;
revoke all on public.onboarding_sessions from public, anon, authenticated;
grant all on public.onboarding_sessions to service_role;
create index onboarding_generation_due on public.onboarding_sessions(job_status, job_lease_until);

create or replace function public.claim_onboarding_generation(p_workspace_id uuid)
returns setof public.onboarding_sessions language plpgsql security definer set search_path = '' as $$
begin
  return query update public.onboarding_sessions s
    set job_status = 'running', job_attempts = job_attempts + 1, job_lease = gen_random_uuid(),
      job_lease_until = now() + interval '3 minutes', updated_at = now()
    where s.workspace_id in (
      select workspace_id from public.onboarding_sessions where workspace_id = p_workspace_id
        and (job_status = 'queued' or (job_status = 'running' and job_lease_until < now()))
        and job_attempts < 2 and status <> 'applied' for update skip locked
    ) returning s.*;
end; $$;
revoke all on function public.claim_onboarding_generation(uuid) from public, anon, authenticated;
grant execute on function public.claim_onboarding_generation(uuid) to service_role;

-- One transaction makes application resumable without duplicate pages, Brain items, or drafts.
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
  insert into public.content_agent_threads(user_id, title) values (p_workspace_id, 'Your first posts') returning id into thread;
  insert into public.content_agent_messages(thread_id, user_id, role, content, payload)
    values (thread, p_workspace_id, 'assistant', 'Your starting point is ready. Review these drafts and make them your own.',
      jsonb_build_object('message', s.candidates->>'nextAction', 'cards', coalesce((
        select jsonb_agg(jsonb_build_object('type', 'draft', 'cardId', 'onboarding-' || ord,
          'platform', b->>'platform', 'format', case when b->>'platform' in ('youtube','tiktok','instagram') then 'short_script' else 'post' end,
          'title', value->>'title', 'body', value->>'body', 'visualBrief', null, 'sourceUrls', '[]'::jsonb,
          'rationale', 'A starter draft based on your approved audience, voice, and goal.'))
        from jsonb_array_elements(s.candidates->'drafts') with ordinality as drafts(value, ord)
      ), '[]'::jsonb)));
  update public.onboarding_sessions set status = 'applied', applied_revision = p_revision, step = 6,
    thread_id = thread, updated_at = now() where workspace_id = p_workspace_id;
  return jsonb_build_object('threadId', thread);
end; $$;
revoke all on function public.apply_onboarding_preparation(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.apply_onboarding_preparation(uuid, integer, jsonb) to service_role;

create table public.app_onboarding_progress (
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  app_id text not null check (length(app_id) between 1 and 60),
  version integer not null default 1,
  dismissed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(workspace_id, app_id)
);
alter table public.app_onboarding_progress enable row level security;
revoke all on public.app_onboarding_progress from public, anon, authenticated;
grant all on public.app_onboarding_progress to service_role;
notify pgrst, 'reload schema';
alter table public.app_onboarding_progress add column first_result_at timestamptz;
