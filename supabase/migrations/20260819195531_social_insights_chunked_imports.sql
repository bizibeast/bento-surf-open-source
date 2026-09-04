alter table public.social_analytics_snapshots
  add column if not exists refresh_job_id uuid,
  add column if not exists refresh_stage text,
  add column if not exists refresh_cursor text,
  add column if not exists refresh_processing_at timestamptz;

alter table public.social_analytics_snapshots
  drop constraint if exists social_analytics_snapshots_refresh_stage_check,
  add constraint social_analytics_snapshots_refresh_stage_check
    check (refresh_stage is null or refresh_stage in ('account', 'content')),
  drop constraint if exists social_analytics_snapshots_refresh_cursor_check,
  add constraint social_analytics_snapshots_refresh_cursor_check
    check (refresh_cursor is null or length(refresh_cursor) <= 4096);

create index if not exists social_analytics_snapshots_refresh_started_idx
  on public.social_analytics_snapshots (refresh_started_at)
  where refresh_started_at is not null;

comment on column public.social_analytics_snapshots.refresh_job_id is
  'Identifies the active chunked history import so stale queue deliveries cannot mutate a newer job.';

comment on column public.social_analytics_snapshots.refresh_stage is
  'Checkpoint stage for the active social insights history import.';

comment on column public.social_analytics_snapshots.refresh_cursor is
  'Provider pagination cursor for the next social insights history import page.';

comment on column public.social_analytics_snapshots.refresh_processing_at is
  'Short processing lease that prevents duplicate queue deliveries from running concurrently.';
