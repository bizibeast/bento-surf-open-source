alter table public.social_analytics_snapshots
  add column if not exists next_refresh_at timestamptz;

update public.social_analytics_snapshots
set next_refresh_at = greatest(now(), fetched_at + interval '24 hours')
where next_refresh_at is null;

create index if not exists social_analytics_snapshots_next_refresh_idx
  on public.social_analytics_snapshots(next_refresh_at, connection_id)
  where next_refresh_at is not null and refresh_started_at is null;

comment on column public.social_analytics_snapshots.next_refresh_at is
  'Next provider refresh due time. Completion moves this to 02:00 in the creator account timezone.';

create or replace function public.claim_due_social_insights_refreshes(
  p_limit integer default 25
)
returns table(
  connection_id uuid,
  user_id uuid,
  job_id uuid,
  stage text,
  cursor text,
  started_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  with due as materialized (
    select snapshot.connection_id
    from public.social_analytics_snapshots snapshot
    join public.social_connections connection
      on connection.id = snapshot.connection_id
     and connection.user_id = snapshot.user_id
    where snapshot.next_refresh_at <= now()
      and snapshot.refresh_started_at is null
      and snapshot.refresh_job_id is null
      and connection.status = 'active'
    order by snapshot.next_refresh_at, snapshot.connection_id
    for update of snapshot skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), updated as (
    update public.social_analytics_snapshots snapshot
    set refresh_job_id = gen_random_uuid(),
        refresh_stage = 'account',
        refresh_cursor = null,
        refresh_processing_at = null,
        refresh_started_at = clock_timestamp(),
        next_refresh_at = null,
        updated_at = clock_timestamp()
    from due
    where snapshot.connection_id = due.connection_id
    returning
      snapshot.connection_id,
      snapshot.user_id,
      snapshot.refresh_job_id,
      snapshot.refresh_stage,
      snapshot.refresh_cursor,
      snapshot.refresh_started_at
  )
  select
    updated.connection_id,
    updated.user_id,
    updated.refresh_job_id,
    updated.refresh_stage,
    updated.refresh_cursor,
    updated.refresh_started_at
  from updated;
$$;

revoke all on function public.claim_due_social_insights_refreshes(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_social_insights_refreshes(integer)
  to service_role;
