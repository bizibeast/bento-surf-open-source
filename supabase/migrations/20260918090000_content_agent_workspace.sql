create table public.creator_content_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  goal text not null default 'consistent_publishing'
    check (goal in ('consistent_publishing', 'reach_growth')),
  niche_keywords text[] not null default '{}'
    check (cardinality(niche_keywords) <= 20),
  language text not null default 'en'
    check (length(language) between 2 and 12),
  region text not null default 'global'
    check (length(region) between 2 and 32),
  timezone text not null default 'UTC'
    check (length(timezone) between 1 and 100),
  platform_frequencies jsonb not null default '{}'::jsonb
    check (jsonb_typeof(platform_frequencies) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.creator_brain_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null
    check (kind in ('profile', 'instruction', 'strategy', 'story', 'inspiration', 'file', 'photo', 'link')),
  title text not null check (length(title) between 1 and 160),
  content text not null check (length(content) between 1 and 20000),
  provenance text not null
    check (provenance in ('creator', 'social_post', 'agent_chat', 'file', 'link')),
  source_url text check (source_url is null or length(source_url) <= 2000),
  source_ref text check (source_ref is null or length(source_ref) <= 500),
  status text not null default 'suggested'
    check (status in ('suggested', 'confirmed')),
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index creator_brain_items_user_kind_updated_idx
  on public.creator_brain_items(user_id, kind, updated_at desc);

create table public.content_trend_briefs (
  id uuid primary key default gen_random_uuid(),
  niche_key text not null check (length(niche_key) between 1 and 500),
  language text not null check (length(language) between 2 and 12),
  region text not null check (length(region) between 2 and 32),
  brief_date date not null,
  items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 50),
  warnings text[] not null default '{}'
    check (cardinality(warnings) <= 20),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (niche_key, language, region, brief_date)
);

create index content_trend_briefs_expiry_idx
  on public.content_trend_briefs(expires_at);

create table public.creator_content_recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  fingerprint text not null check (length(fingerprint) between 1 and 500),
  kind text not null check (kind in ('winner', 'pattern', 'trend', 'idea')),
  title text not null check (length(title) between 1 and 300),
  summary text not null default '' check (length(summary) <= 5000),
  source_url text check (source_url is null or length(source_url) <= 2000),
  source_name text check (source_name is null or length(source_name) <= 160),
  source_published_at timestamptz,
  source_retrieved_at timestamptz,
  reason text not null default '' check (length(reason) <= 2000),
  angles jsonb not null default '[]'::jsonb
    check (jsonb_typeof(angles) = 'array' and jsonb_array_length(angles) <= 3),
  metric_name text check (metric_name is null or metric_name in ('views', 'impressions', 'reach', 'engagements', 'engagement_rate')),
  metric_value numeric check (metric_value is null or metric_value >= 0),
  outlier_score numeric check (outlier_score is null or outlier_score >= 0),
  content_insight_id uuid references public.social_content_insights(id) on delete set null,
  trend_brief_id uuid references public.content_trend_briefs(id) on delete set null,
  feedback text not null default 'pending'
    check (feedback in ('pending', 'saved', 'not_relevant')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index creator_content_recommendations_fingerprint_unique
  on public.creator_content_recommendations(user_id, fingerprint);

create index creator_content_recommendations_user_created_idx
  on public.creator_content_recommendations(user_id, created_at desc);

create table public.content_agent_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'New conversation'
    check (length(title) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (id, user_id)
);

create index content_agent_threads_user_activity_idx
  on public.content_agent_threads(user_id, last_message_at desc);

create table public.content_agent_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system_event')),
  content text not null default '' check (length(content) <= 20000),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '180 days'),
  foreign key (thread_id, user_id)
    references public.content_agent_threads(id, user_id) on delete cascade
);

create index content_agent_messages_thread_created_idx
  on public.content_agent_messages(thread_id, created_at);
create index content_agent_messages_expiry_idx
  on public.content_agent_messages(expires_at);

create table public.content_routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  template text not null
    check (template in ('nightly_niche_brief', 'fill_schedule', 'morning_ready_email', 'weekly_performance_review')),
  enabled boolean not null default false,
  schedule jsonb not null default '{"intervalMinutes":1440}'::jsonb
    check (jsonb_typeof(schedule) = 'object'),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 100),
  platforms text[] not null default '{}'
    check (cardinality(platforms) <= 8),
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, template)
);

create index content_routines_due_idx
  on public.content_routines(next_run_at)
  where enabled and next_run_at is not null;

create table public.content_routine_runs (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.content_routines(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  scheduled_for timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  lease_expires_at timestamptz,
  result_count integer not null default 0 check (result_count >= 0),
  error_message text check (error_message is null or length(error_message) <= 1000),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (routine_id, scheduled_for)
);

create index content_routine_runs_user_created_idx
  on public.content_routine_runs(user_id, created_at desc);
create index content_routine_runs_lease_idx
  on public.content_routine_runs(lease_expires_at)
  where status = 'running';

create trigger creator_content_profiles_updated_at
  before update on public.creator_content_profiles
  for each row execute function public.tg_set_updated_at();
create trigger creator_brain_items_updated_at
  before update on public.creator_brain_items
  for each row execute function public.tg_set_updated_at();
create trigger content_trend_briefs_updated_at
  before update on public.content_trend_briefs
  for each row execute function public.tg_set_updated_at();
create trigger creator_content_recommendations_updated_at
  before update on public.creator_content_recommendations
  for each row execute function public.tg_set_updated_at();
create trigger content_agent_threads_updated_at
  before update on public.content_agent_threads
  for each row execute function public.tg_set_updated_at();
create trigger content_routines_updated_at
  before update on public.content_routines
  for each row execute function public.tg_set_updated_at();

alter table public.creator_content_profiles enable row level security;
alter table public.creator_brain_items enable row level security;
alter table public.content_trend_briefs enable row level security;
alter table public.creator_content_recommendations enable row level security;
alter table public.content_agent_threads enable row level security;
alter table public.content_agent_messages enable row level security;
alter table public.content_routines enable row level security;
alter table public.content_routine_runs enable row level security;

revoke all on public.creator_content_profiles from public, anon;
revoke all on public.creator_brain_items from public, anon;
revoke all on public.creator_content_recommendations from public, anon;
revoke all on public.content_agent_threads from public, anon;
revoke all on public.content_agent_messages from public, anon;
revoke all on public.content_routines from public, anon;
revoke all on public.content_routine_runs from public, anon, authenticated;
revoke all on public.content_trend_briefs from public, anon, authenticated;

grant select, insert, update, delete on public.creator_content_profiles to authenticated;
grant select, insert, update, delete on public.creator_brain_items to authenticated;
grant select, insert, update, delete on public.creator_content_recommendations to authenticated;
grant select, insert, update, delete on public.content_agent_threads to authenticated;
grant select, insert, update, delete on public.content_agent_messages to authenticated;
grant select, insert, update, delete on public.content_routines to authenticated;
grant select on public.content_routine_runs to authenticated;

grant all on public.creator_content_profiles to service_role;
grant all on public.creator_brain_items to service_role;
grant all on public.content_trend_briefs to service_role;
grant all on public.creator_content_recommendations to service_role;
grant all on public.content_agent_threads to service_role;
grant all on public.content_agent_messages to service_role;
grant all on public.content_routines to service_role;
grant all on public.content_routine_runs to service_role;

create policy creator_content_profiles_owner_all
  on public.creator_content_profiles for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy creator_brain_items_owner_all
  on public.creator_brain_items for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy creator_content_recommendations_owner_all
  on public.creator_content_recommendations for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy content_agent_threads_owner_all
  on public.content_agent_threads for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy content_agent_messages_owner_all
  on public.content_agent_messages for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy content_routines_owner_all
  on public.content_routines for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy content_routine_runs_owner_select
  on public.content_routine_runs for select
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.claim_due_content_routines(
  p_limit integer default 25,
  p_now timestamptz default now()
)
returns setof public.content_routine_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  routine_row public.content_routines%rowtype;
  run_row public.content_routine_runs%rowtype;
  scheduled_time timestamptz;
  interval_minutes integer;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'routine claim limit must be between 1 and 100';
  end if;

  for routine_row in
    select *
    from public.content_routines
    where enabled = true
      and next_run_at is not null
      and next_run_at <= p_now
    order by next_run_at
    for update skip locked
    limit p_limit
  loop
    scheduled_time := routine_row.next_run_at;
    begin
      interval_minutes := coalesce((routine_row.schedule ->> 'intervalMinutes')::integer, 1440);
    exception when others then
      interval_minutes := 1440;
    end;
    interval_minutes := greatest(15, least(10080, interval_minutes));

    insert into public.content_routine_runs (
      routine_id,
      user_id,
      scheduled_for,
      status,
      attempts,
      lease_expires_at,
      started_at
    ) values (
      routine_row.id,
      routine_row.user_id,
      scheduled_time,
      'running',
      1,
      p_now + interval '10 minutes',
      p_now
    )
    on conflict (routine_id, scheduled_for) do update
      set status = 'running',
          attempts = public.content_routine_runs.attempts + 1,
          lease_expires_at = p_now + interval '10 minutes',
          started_at = coalesce(public.content_routine_runs.started_at, p_now),
          error_message = null
      where public.content_routine_runs.status in ('pending', 'failed')
         or (
           public.content_routine_runs.status = 'running'
           and public.content_routine_runs.lease_expires_at <= p_now
         )
    returning * into run_row;

    update public.content_routines
    set next_run_at = scheduled_time + make_interval(mins => interval_minutes)
    where id = routine_row.id;

    if run_row.id is not null then
      return next run_row;
    end if;
    run_row := null;
  end loop;
end;
$$;

create or replace function public.finish_content_routine_run(
  p_run_id uuid,
  p_status text,
  p_result_count integer default 0,
  p_error_message text default null,
  p_next_run_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
  routine_key uuid;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid content routine completion status';
  end if;

  update public.content_routine_runs
  set status = p_status,
      result_count = greatest(0, p_result_count),
      error_message = case
        when p_error_message is null then null
        else left(p_error_message, 1000)
      end,
      lease_expires_at = null,
      completed_at = now()
  where id = p_run_id
    and status = 'running'
  returning routine_id into routine_key;

  get diagnostics affected = row_count;
  if affected = 0 then
    return false;
  end if;

  update public.content_routines
  set last_run_at = now(),
      next_run_at = coalesce(p_next_run_at, next_run_at)
  where id = routine_key;

  return true;
end;
$$;

revoke all on function public.claim_due_content_routines(integer, timestamptz) from public, anon, authenticated;
revoke all on function public.finish_content_routine_run(uuid, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_content_routines(integer, timestamptz) to service_role;
grant execute on function public.finish_content_routine_run(uuid, text, integer, text, timestamptz) to service_role;
