-- Stop reclaiming permanently rejected missed-comment checks until reconnect.
alter table public.social_connections
  add column comment_reconcile_permanent_failures integer not null default 0
    check (comment_reconcile_permanent_failures >= 0),
  add column comment_reconcile_next_check_at timestamptz,
  add column comment_reconcile_paused_at timestamptz,
  add column comment_reconcile_last_provider_code text;

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
  v_now timestamptz := clock_timestamp();
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
      and connection.comment_reconcile_paused_at is null
      and (connection.comment_reconcile_next_check_at is null
        or connection.comment_reconcile_next_check_at <= v_now)
      and connection.token_expires_at > v_now
      and (
        connection.last_comment_reconcile_at is null
        or connection.last_comment_reconcile_at
          < v_now - make_interval(secs => bounded_interval_seconds)
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
      last_comment_reconcile_at = v_now,
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
