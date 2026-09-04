alter table public.social_analytics_snapshots
  add column if not exists reach bigint;

alter table public.social_analytics_snapshots
  drop constraint if exists social_analytics_snapshot_reach_check;

alter table public.social_analytics_snapshots
  add constraint social_analytics_snapshot_reach_check
  check (reach is null or reach >= 0);
