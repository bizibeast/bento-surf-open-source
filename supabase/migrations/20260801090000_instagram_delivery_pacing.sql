-- Serialize outbound Instagram automation deliveries per connected account and
-- share Meta's provider backoff across concurrent Cloudflare queue consumers.
-- This is deliberately a short safety interval, not an invented hourly quota:
-- Meta remains the source of truth through Retry-After and Graph error codes.
create table public.instagram_delivery_slots (
  connection_id uuid primary key references public.social_connections(id) on delete cascade,
  next_available_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.instagram_delivery_slots enable row level security;
revoke all on public.instagram_delivery_slots from public, anon, authenticated;
grant all on public.instagram_delivery_slots to service_role;

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
  current_time timestamptz := clock_timestamp();
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

  if current_next > current_time then
    return query
      select greatest(
        1,
        ceil(extract(epoch from (current_next - current_time)) * 1000)::integer
      );
    return;
  end if;

  update public.instagram_delivery_slots slot
  set
    next_available_at = current_time + make_interval(secs => bounded_interval_ms / 1000.0),
    last_attempt_at = current_time,
    updated_at = current_time
  where slot.connection_id = p_connection_id;

  return query select 0;
end;
$$;

revoke all on function public.claim_instagram_delivery_slot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_instagram_delivery_slot(uuid, integer)
  to service_role;

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
  current_time timestamptz := clock_timestamp();
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
    current_time + make_interval(secs => bounded_delay_seconds),
    current_time
  from public.social_connections connection
  where connection.id = p_connection_id
    and connection.provider = 'instagram'
  on conflict (connection_id) do update
  set
    next_available_at = greatest(
      public.instagram_delivery_slots.next_available_at,
      excluded.next_available_at
    ),
    updated_at = current_time;
end;
$$;

revoke all on function public.defer_instagram_delivery_slot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.defer_instagram_delivery_slot(uuid, integer)
  to service_role;

comment on table public.instagram_delivery_slots is
  'Service-only per-account Instagram delivery pacing and provider-directed backoff.';
comment on function public.claim_instagram_delivery_slot(uuid, integer) is
  'Atomically reserves a short outbound delivery interval for one Instagram connection.';
comment on function public.defer_instagram_delivery_slot(uuid, integer) is
  'Extends a connection delivery pause after Meta rate-limit or Retry-After guidance.';
