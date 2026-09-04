create table if not exists public.social_analytics_history (
  id bigint generated always as identity primary key,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  followers bigint,
  following bigint,
  posts bigint,
  views bigint,
  reach bigint,
  engagements bigint,
  status text not null,
  captured_at timestamptz not null default now(),
  constraint social_analytics_history_metrics_check check (
    (followers is null or followers >= 0) and
    (following is null or following >= 0) and
    (posts is null or posts >= 0) and
    (views is null or views >= 0) and
    (reach is null or reach >= 0) and
    (engagements is null or engagements >= 0)
  ),
  constraint social_analytics_history_status_check check (
    status in ('available', 'partial', 'unavailable', 'error')
  )
);

create index if not exists social_analytics_history_account_idx
  on public.social_analytics_history(connection_id, captured_at desc);

create index if not exists social_analytics_history_user_idx
  on public.social_analytics_history(user_id, captured_at desc);

alter table public.social_analytics_history enable row level security;
revoke all on public.social_analytics_history from public, anon, authenticated;
grant all on public.social_analytics_history to service_role;
