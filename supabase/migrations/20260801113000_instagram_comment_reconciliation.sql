-- Meta webhooks are the primary event source, but delivery is best-effort. A
-- narrow, service-only reconciliation lease lets the Worker recover recent
-- comments without allowing concurrent cron invocations to scan one account.

alter table public.social_connections
  add column if not exists last_comment_reconcile_at timestamptz,
  add column if not exists last_comment_reconcile_completed_at timestamptz,
  add column if not exists last_comment_reconcile_error text;

create index if not exists social_connections_instagram_reconcile_idx
  on public.social_connections(last_comment_reconcile_at, id)
  where provider = 'instagram'
    and status = 'active'
    and connection_health = 'healthy'
    and reauth_required = false;

create or replace function public.claim_instagram_comment_reconciliations(
  p_batch_size integer default 25,
  p_min_interval_seconds integer default 300
)
returns table(connection_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_time timestamptz := clock_timestamp();
  bounded_batch_size integer := greatest(1, least(coalesce(p_batch_size, 25), 100));
  bounded_interval_seconds integer := greatest(
    60,
    least(coalesce(p_min_interval_seconds, 300), 3600)
  );
begin
  return query
  with due as (
    select connection.id
    from public.social_connections connection
    where connection.provider = 'instagram'
      and connection.status = 'active'
      and connection.connection_health = 'healthy'
      and connection.reauth_required = false
      and connection.token_expires_at > current_time
      and (
        connection.last_comment_reconcile_at is null
        or connection.last_comment_reconcile_at
          < current_time - make_interval(secs => bounded_interval_seconds)
      )
      and exists (
        select 1
        from public.instagram_dm_automations automation
        where automation.connection_id = connection.id
          and automation.enabled = true
          and automation.trigger_type in ('comment_keyword', 'any_comment')
      )
    order by connection.last_comment_reconcile_at asc nulls first, connection.id asc
    for update of connection skip locked
    limit bounded_batch_size
  ), claimed as (
    update public.social_connections connection
    set
      last_comment_reconcile_at = current_time,
      last_comment_reconcile_error = null
    from due
    where connection.id = due.id
    returning connection.id
  )
  select claimed.id from claimed;
end;
$$;

revoke all on function public.claim_instagram_comment_reconciliations(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_instagram_comment_reconciliations(integer, integer)
  to service_role;

comment on column public.social_connections.last_comment_reconcile_at is
  'Last atomic claim for the bounded official-API missed-comment safety sweep.';
comment on column public.social_connections.last_comment_reconcile_completed_at is
  'Last missed-comment sweep that fully fetched and enqueued its bounded window.';
comment on column public.social_connections.last_comment_reconcile_error is
  'Sanitized result of the latest failed missed-comment sweep, cleared on success.';
comment on function public.claim_instagram_comment_reconciliations(integer, integer) is
  'Atomically leases due healthy Instagram connections for missed-comment recovery.';
