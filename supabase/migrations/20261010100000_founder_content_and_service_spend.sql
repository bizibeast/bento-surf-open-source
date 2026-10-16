-- Aggregate creator adoption without exposing private Brain or Agent content.
create or replace function public.get_founder_content_adoption(
  p_period_start timestamptz,
  p_period_end timestamptz
) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
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

-- Invoice-backed entries for services without a billing API connection.
create table if not exists public.founder_service_expenses (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (length(provider) between 2 and 80),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  period_start date not null,
  period_end date not null,
  note text not null default '' check (length(note) <= 300),
  created_at timestamptz not null default now(),
  constraint founder_service_expenses_period_check check (period_end >= period_start)
);
create index if not exists founder_service_expenses_period_idx on public.founder_service_expenses(period_start desc);
alter table public.founder_service_expenses enable row level security;
revoke all on public.founder_service_expenses from public, anon, authenticated;
grant all on public.founder_service_expenses to service_role;
