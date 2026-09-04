-- PostgreSQL parses CURRENT_TIME as the SQL time-with-time-zone expression,
-- even inside PL/pgSQL functions that declare a variable with the same name.
-- Use an unambiguous timestamp variable so delivery pacing and missed-comment
-- reconciliation compare timestamptz values consistently.

create or replace function public.claim_instagram_delivery_slot(
  p_connection_id uuid,
  p_min_interval_ms integer default 500
)
returns table(wait_ms integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  current_next timestamptz;
  bounded_interval_ms integer := greatest(100, least(coalesce(p_min_interval_ms, 500), 5000));
begin
  if not exists (
    select 1
    from public.social_connections connection
    where connection.id = p_connection_id
      and connection.provider = 'instagram'
  ) then
    raise exception 'Instagram connection does not exist';
  end if;

  insert into public.instagram_delivery_slots (connection_id)
  values (p_connection_id)
  on conflict (connection_id) do nothing;

  select slot.next_available_at
  into current_next
  from public.instagram_delivery_slots slot
  where slot.connection_id = p_connection_id
  for update;

  if current_next > v_now then
    return query
      select greatest(
        1,
        ceil(extract(epoch from (current_next - v_now)) * 1000)::integer
      );
    return;
  end if;

  update public.instagram_delivery_slots slot
  set
    next_available_at = v_now + make_interval(secs => bounded_interval_ms / 1000.0),
    last_attempt_at = v_now,
    updated_at = v_now
  where slot.connection_id = p_connection_id;

  return query select 0;
end;
$$;

create or replace function public.defer_instagram_delivery_slot(
  p_connection_id uuid,
  p_retry_after_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  bounded_delay_seconds integer := greatest(
    1,
    least(coalesce(p_retry_after_seconds, 60), 3600)
  );
begin
  insert into public.instagram_delivery_slots (
    connection_id,
    next_available_at,
    updated_at
  )
  select
    connection.id,
    v_now + make_interval(secs => bounded_delay_seconds),
    v_now
  from public.social_connections connection
  where connection.id = p_connection_id
    and connection.provider = 'instagram'
  on conflict (connection_id) do update
  set
    next_available_at = greatest(
      public.instagram_delivery_slots.next_available_at,
      excluded.next_available_at
    ),
    updated_at = v_now;
end;
$$;

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

revoke all on function public.claim_instagram_delivery_slot(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.defer_instagram_delivery_slot(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.claim_instagram_comment_reconciliations(integer, integer)
  from public, anon, authenticated;

grant execute on function public.claim_instagram_delivery_slot(uuid, integer)
  to service_role;
grant execute on function public.defer_instagram_delivery_slot(uuid, integer)
  to service_role;
grant execute on function public.claim_instagram_comment_reconciliations(integer, integer)
  to service_role;

comment on function public.claim_instagram_delivery_slot(uuid, integer) is
  'Atomically reserves a short outbound delivery interval using timestamptz-safe comparisons.';
comment on function public.defer_instagram_delivery_slot(uuid, integer) is
  'Extends a connection delivery pause using timestamptz-safe calculations.';
comment on function public.claim_instagram_comment_reconciliations(integer, integer) is
  'Atomically leases due healthy Instagram connections using timestamptz-safe comparisons.';
