-- A failed import used to clear next_refresh_at, leaving the account outside
-- the daily refresh claim forever. Repair existing rows and keep null-due
-- snapshots eligible after their last fetch ages past 24 hours.
update public.social_analytics_snapshots snapshot
set next_refresh_at = now()
from public.social_connections connection
where connection.id = snapshot.connection_id
  and connection.status = 'active'
  and snapshot.next_refresh_at is null
  and snapshot.refresh_job_id is null;

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
    where (
        snapshot.next_refresh_at <= now()
        or (
          snapshot.next_refresh_at is null
          and snapshot.fetched_at <= now() - interval '24 hours'
        )
      )
      and snapshot.refresh_started_at is null
      and snapshot.refresh_job_id is null
      and connection.status = 'active'
    order by coalesce(snapshot.next_refresh_at, snapshot.fetched_at + interval '24 hours'),
      snapshot.connection_id
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
