-- One row per workspace and UTC day records actual Brain visits without storing content.
create table if not exists public.founder_brain_daily_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index if not exists founder_brain_daily_usage_day_idx on public.founder_brain_daily_usage(day desc);
alter table public.founder_brain_daily_usage enable row level security;
revoke all on public.founder_brain_daily_usage from public, anon, authenticated;
grant all on public.founder_brain_daily_usage to service_role;

create or replace function public.get_founder_content_adoption(
  p_period_start timestamptz,
  p_period_end timestamptz
) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'brainVisitors', (select count(distinct user_id) from public.founder_brain_daily_usage),
    'brainVisitorsPeriod', (select count(distinct user_id) from public.founder_brain_daily_usage where day >= p_period_start::date and day <= p_period_end::date),
    'brainUsers', (select count(distinct user_id) from public.creator_brain_items where status = 'confirmed'),
    'brainUsersPeriod', (select count(distinct user_id) from public.creator_brain_items where status = 'confirmed' and updated_at >= p_period_start and updated_at < p_period_end),
    'confirmedBrainItems', (select count(*) from public.creator_brain_items where status = 'confirmed'),
    'agentUsersPeriod', (select count(distinct user_id) from public.content_agent_messages where role = 'user' and created_at >= p_period_start and created_at < p_period_end),
    'agentTurnsPeriod', (select count(*) from public.content_agent_messages where role = 'user' and created_at >= p_period_start and created_at < p_period_end),
    'routineUsersPeriod', (select count(distinct user_id) from public.content_routine_runs where created_at >= p_period_start and created_at < p_period_end),
    'routineRunsPeriod', (select count(*) from public.content_routine_runs where created_at >= p_period_start and created_at < p_period_end),
    'successfulRoutineRunsPeriod', (select count(*) from public.content_routine_runs where status = 'succeeded' and created_at >= p_period_start and created_at < p_period_end)
  );
$$;
revoke all on function public.get_founder_content_adoption(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.get_founder_content_adoption(timestamptz, timestamptz) to service_role;
