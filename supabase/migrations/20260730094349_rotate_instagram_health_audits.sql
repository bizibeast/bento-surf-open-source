-- Track every provider health-check attempt separately from the last
-- successful verification. This prevents a transient Meta outage from keeping
-- the same failing accounts at the front of each bounded audit batch.
alter table public.social_connections
  add column if not exists last_health_check_at timestamptz;

create index if not exists social_connections_instagram_health_check_idx
  on public.social_connections(last_health_check_at, id)
  where provider = 'instagram' and status = 'active';

comment on column public.social_connections.last_health_check_at is
  'Last provider health audit attempt, successful or not; used to rotate scheduled checks fairly.';

-- This table is intentionally service-role only.
revoke all on public.social_connections from anon, authenticated;
grant all on public.social_connections to service_role;
