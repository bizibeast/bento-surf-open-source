-- Analytics at creator scale: raw events remain an audit trail, while every
-- dashboard read is served from bounded hourly/daily rollups. Statement-level
-- triggers make queue retries idempotent because only newly inserted raw rows
-- reach the rollups.

create table if not exists public.analytics_hourly (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_start timestamptz not null,
  views bigint not null default 0 check (views >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  primary key (user_id, bucket_start)
);

create table if not exists public.analytics_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  views bigint not null default 0 check (views >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  unique_visitors bigint not null default 0 check (unique_visitors >= 0),
  primary key (user_id, day)
);

create table if not exists public.analytics_daily_dimensions (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  dimension text not null check (dimension in ('device', 'browser', 'country', 'city', 'source')),
  value text not null,
  count bigint not null default 0 check (count >= 0),
  primary key (user_id, day, dimension, value)
);

create table if not exists public.analytics_block_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  block_id uuid not null references public.blocks(id) on delete cascade,
  day date not null,
  clicks bigint not null default 0 check (clicks >= 0),
  primary key (user_id, block_id, day)
);

-- Exact daily uniqueness is kept separately. The dashboard reports the sum of
-- daily uniques for multi-day ranges, the standard DAU-style definition.
create table if not exists public.analytics_daily_visitors (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  visitor_hash text not null,
  primary key (user_id, day, visitor_hash)
);

create index if not exists analytics_hourly_bucket_idx
  on public.analytics_hourly(bucket_start, user_id);
create index if not exists analytics_daily_day_idx
  on public.analytics_daily(day, user_id);
create index if not exists analytics_dimensions_lookup_idx
  on public.analytics_daily_dimensions(user_id, dimension, day);
create index if not exists analytics_block_lookup_idx
  on public.analytics_block_daily(user_id, day, block_id);
create index if not exists profile_views_created_at_brin_idx
  on public.profile_views using brin(created_at);
create index if not exists block_clicks_created_at_brin_idx
  on public.block_clicks using brin(created_at);

alter table public.analytics_hourly enable row level security;
alter table public.analytics_daily enable row level security;
alter table public.analytics_daily_dimensions enable row level security;
alter table public.analytics_block_daily enable row level security;
alter table public.analytics_daily_visitors enable row level security;

grant select on public.analytics_hourly, public.analytics_daily,
  public.analytics_daily_dimensions, public.analytics_block_daily to authenticated;
grant all on public.analytics_hourly, public.analytics_daily,
  public.analytics_daily_dimensions, public.analytics_block_daily,
  public.analytics_daily_visitors to service_role;

drop policy if exists analytics_hourly_owner_read on public.analytics_hourly;
create policy analytics_hourly_owner_read on public.analytics_hourly for select
  to authenticated using (auth.uid() = user_id);
drop policy if exists analytics_daily_owner_read on public.analytics_daily;
create policy analytics_daily_owner_read on public.analytics_daily for select
  to authenticated using (auth.uid() = user_id);
drop policy if exists analytics_dimensions_owner_read on public.analytics_daily_dimensions;
create policy analytics_dimensions_owner_read on public.analytics_daily_dimensions for select
  to authenticated using (auth.uid() = user_id);
drop policy if exists analytics_block_owner_read on public.analytics_block_daily;
create policy analytics_block_owner_read on public.analytics_block_daily for select
  to authenticated using (auth.uid() = user_id);

create or replace function public.rollup_profile_view_inserts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.analytics_hourly(user_id, bucket_start, views)
  select user_id, date_trunc('hour', created_at), count(*)
  from inserted_profile_views
  group by user_id, date_trunc('hour', created_at)
  on conflict (user_id, bucket_start) do update
    set views = public.analytics_hourly.views + excluded.views;

  with per_day as (
    select user_id, (created_at at time zone 'UTC')::date as day, count(*) as views
    from inserted_profile_views
    group by user_id, (created_at at time zone 'UTC')::date
  ), inserted_visitors as (
    insert into public.analytics_daily_visitors(user_id, day, visitor_hash)
    select distinct user_id, (created_at at time zone 'UTC')::date, visitor_hash
    from inserted_profile_views
    where visitor_hash is not null and visitor_hash <> ''
    on conflict do nothing
    returning user_id, day
  ), unique_by_day as (
    select user_id, day, count(*) as unique_visitors
    from inserted_visitors
    group by user_id, day
  )
  insert into public.analytics_daily(user_id, day, views, unique_visitors)
  select per_day.user_id, per_day.day, per_day.views, coalesce(unique_by_day.unique_visitors, 0)
  from per_day
  left join unique_by_day using (user_id, day)
  on conflict (user_id, day) do update set
    views = public.analytics_daily.views + excluded.views,
    unique_visitors = public.analytics_daily.unique_visitors + excluded.unique_visitors;

  insert into public.analytics_daily_dimensions(user_id, day, dimension, value, count)
  select
    row.user_id,
    (row.created_at at time zone 'UTC')::date,
    item.dimension,
    left(item.value, 160),
    count(*)
  from inserted_profile_views row
  cross join lateral (
    values
      ('device', row.device),
      ('browser', row.browser),
      ('country', row.country),
      ('city', row.city),
      ('source', row.source)
  ) as item(dimension, value)
  where item.value is not null and item.value <> ''
  group by row.user_id, (row.created_at at time zone 'UTC')::date,
    item.dimension, left(item.value, 160)
  on conflict (user_id, day, dimension, value) do update
    set count = public.analytics_daily_dimensions.count + excluded.count;

  return null;
end;
$$;

create or replace function public.rollup_block_click_inserts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.analytics_hourly(user_id, bucket_start, clicks)
  select user_id, date_trunc('hour', created_at), count(*)
  from inserted_block_clicks
  group by user_id, date_trunc('hour', created_at)
  on conflict (user_id, bucket_start) do update
    set clicks = public.analytics_hourly.clicks + excluded.clicks;

  insert into public.analytics_daily(user_id, day, clicks)
  select user_id, (created_at at time zone 'UTC')::date, count(*)
  from inserted_block_clicks
  group by user_id, (created_at at time zone 'UTC')::date
  on conflict (user_id, day) do update
    set clicks = public.analytics_daily.clicks + excluded.clicks;

  insert into public.analytics_block_daily(user_id, block_id, day, clicks)
  select user_id, block_id, (created_at at time zone 'UTC')::date, count(*)
  from inserted_block_clicks
  group by user_id, block_id, (created_at at time zone 'UTC')::date
  on conflict (user_id, block_id, day) do update
    set clicks = public.analytics_block_daily.clicks + excluded.clicks;

  return null;
end;
$$;

drop trigger if exists profile_views_rollup on public.profile_views;
create trigger profile_views_rollup
  after insert on public.profile_views
  referencing new table as inserted_profile_views
  for each statement execute function public.rollup_profile_view_inserts();

drop trigger if exists block_clicks_rollup on public.block_clicks;
create trigger block_clicks_rollup
  after insert on public.block_clicks
  referencing new table as inserted_block_clicks
  for each statement execute function public.rollup_block_click_inserts();

revoke all on function public.rollup_profile_view_inserts() from public;
revoke all on function public.rollup_block_click_inserts() from public;

-- One trusted RPC accepts a whole Cloudflare Queue batch. Invalid profile and
-- block IDs are ignored rather than failing and retrying every valid event in
-- the same batch.
create or replace function public.ingest_analytics_batch(p_events jsonb)
returns table(views_inserted integer, clicks_inserted integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_views integer := 0;
  inserted_clicks integer := 0;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 100 then
    raise exception 'analytics batch must be an array of at most 100 events';
  end if;

  with parsed as (
    select * from jsonb_to_recordset(p_events) as event(
      event_id uuid, kind text, user_id uuid, block_id uuid, visitor_hash text,
      referrer text, user_agent text, device text, browser text,
      country text, city text, source text
    )
  ), inserted as (
    insert into public.profile_views(
      event_id, user_id, visitor_hash, referrer, user_agent,
      device, browser, country, city, source
    )
    select
      event.event_id, event.user_id, left(event.visitor_hash, 64), left(event.referrer, 512),
      left(event.user_agent, 512), left(event.device, 32), left(event.browser, 64),
      left(event.country, 8), left(event.city, 160), left(event.source, 80)
    from parsed event
    join public.profiles profile on profile.id = event.user_id
    where event.kind = 'view' and event.event_id is not null
    on conflict (event_id) do nothing
    returning 1
  )
  select count(*)::integer into inserted_views from inserted;

  with parsed as (
    select * from jsonb_to_recordset(p_events) as event(
      event_id uuid, kind text, user_id uuid, block_id uuid, visitor_hash text,
      referrer text, user_agent text, device text, browser text,
      country text, city text, source text
    )
  ), inserted as (
    insert into public.block_clicks(
      event_id, user_id, block_id, visitor_hash, referrer, user_agent,
      device, browser, country, city, source
    )
    select
      event.event_id, event.user_id, event.block_id, left(event.visitor_hash, 64),
      left(event.referrer, 512), left(event.user_agent, 512), left(event.device, 32),
      left(event.browser, 64), left(event.country, 8), left(event.city, 160),
      left(event.source, 80)
    from parsed event
    join public.blocks block on block.id = event.block_id and block.user_id = event.user_id
    where event.kind = 'click' and event.event_id is not null and event.block_id is not null
    on conflict (event_id) do nothing
    returning 1
  )
  select count(*)::integer into inserted_clicks from inserted;

  return query select inserted_views, inserted_clicks;
end;
$$;

revoke all on function public.ingest_analytics_batch(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_analytics_batch(jsonb) to service_role;

-- A single database call produces a bounded creator dashboard payload instead
-- of shipping millions of raw events into a Worker and aggregating in memory.
create or replace function public.get_creator_analytics(p_start_date date default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with owner as (
    select auth.uid() as user_id
  ), daily_rows as (
    select analytics.*
    from public.analytics_daily analytics, owner
    where analytics.user_id = owner.user_id
      and (p_start_date is null or analytics.day >= p_start_date)
  ), hourly_totals as (
    select extract(hour from bucket_start at time zone 'UTC')::integer as hour,
      sum(views)::bigint as views
    from public.analytics_hourly analytics, owner
    where analytics.user_id = owner.user_id
      and (p_start_date is null or bucket_start >= p_start_date::timestamptz)
    group by 1
  ), dimension_totals as (
    select dimension, value, sum(count)::bigint as count
    from public.analytics_daily_dimensions analytics, owner
    where analytics.user_id = owner.user_id
      and (p_start_date is null or analytics.day >= p_start_date)
    group by dimension, value
  ), block_totals as (
    select block_id, sum(clicks)::bigint as clicks
    from public.analytics_block_daily analytics, owner
    where analytics.user_id = owner.user_id
      and (p_start_date is null or analytics.day >= p_start_date)
    group by block_id
  )
  select jsonb_build_object(
    'totalViews', coalesce((select sum(views) from daily_rows), 0),
    'totalClicks', coalesce((select sum(clicks) from daily_rows), 0),
    'uniqueVisitors', coalesce((select sum(unique_visitors) from daily_rows), 0),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day, 'views', views, 'clicks', clicks, 'uniqueVisitors', unique_visitors
      ) order by day) from daily_rows
    ), '[]'::jsonb),
    'hourly', (
      select jsonb_agg(coalesce(hourly_totals.views, 0) order by series.hour)
      from generate_series(0, 23) as series(hour)
      left join hourly_totals on hourly_totals.hour = series.hour
    ),
    'dimensions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'value', value, 'count', count
      ) order by dimension, count desc) from dimension_totals
    ), '[]'::jsonb),
    'blockClicks', coalesce((
      select jsonb_agg(jsonb_build_object('blockId', block_id, 'clicks', clicks)
        order by clicks desc) from block_totals
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_creator_analytics(date) from public, anon;
grant execute on function public.get_creator_analytics(date) to authenticated, service_role;

create or replace function public.get_founder_analytics_activity()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'pagesWithVisitors7d', count(distinct user_id) filter (where day >= current_date - 6),
    'pagesWithVisitors30d', count(distinct user_id) filter (where day >= current_date - 29)
  )
  from public.analytics_daily
  where day >= current_date - 29 and views > 0;
$$;

revoke all on function public.get_founder_analytics_activity() from public, anon, authenticated;
grant execute on function public.get_founder_analytics_activity() to service_role;

-- Backfill once from existing raw data. Assignments (rather than increments)
-- make the migration safe to retry during staging rehearsals.
insert into public.analytics_hourly(user_id, bucket_start, views)
select user_id, date_trunc('hour', created_at), count(*)
from public.profile_views group by user_id, date_trunc('hour', created_at)
on conflict (user_id, bucket_start) do update set views = excluded.views;

insert into public.analytics_hourly(user_id, bucket_start, clicks)
select user_id, date_trunc('hour', created_at), count(*)
from public.block_clicks group by user_id, date_trunc('hour', created_at)
on conflict (user_id, bucket_start) do update set clicks = excluded.clicks;

insert into public.analytics_daily_visitors(user_id, day, visitor_hash)
select distinct user_id, (created_at at time zone 'UTC')::date, visitor_hash
from public.profile_views where visitor_hash is not null and visitor_hash <> ''
on conflict do nothing;

insert into public.analytics_daily(user_id, day, views, unique_visitors)
select views.user_id, views.day, views.views, coalesce(visitors.unique_visitors, 0)
from (
  select user_id, (created_at at time zone 'UTC')::date as day, count(*) as views
  from public.profile_views group by user_id, (created_at at time zone 'UTC')::date
) views
left join (
  select user_id, day, count(*) as unique_visitors
  from public.analytics_daily_visitors group by user_id, day
) visitors using (user_id, day)
on conflict (user_id, day) do update set
  views = excluded.views, unique_visitors = excluded.unique_visitors;

insert into public.analytics_daily(user_id, day, clicks)
select user_id, (created_at at time zone 'UTC')::date, count(*)
from public.block_clicks group by user_id, (created_at at time zone 'UTC')::date
on conflict (user_id, day) do update set clicks = excluded.clicks;

insert into public.analytics_daily_dimensions(user_id, day, dimension, value, count)
select row.user_id, (row.created_at at time zone 'UTC')::date, item.dimension,
  left(item.value, 160), count(*)
from public.profile_views row
cross join lateral (
  values ('device', row.device), ('browser', row.browser), ('country', row.country),
    ('city', row.city), ('source', row.source)
) as item(dimension, value)
where item.value is not null and item.value <> ''
group by row.user_id, (row.created_at at time zone 'UTC')::date,
  item.dimension, left(item.value, 160)
on conflict (user_id, day, dimension, value) do update set count = excluded.count;

insert into public.analytics_block_daily(user_id, block_id, day, clicks)
select user_id, block_id, (created_at at time zone 'UTC')::date, count(*)
from public.block_clicks group by user_id, block_id, (created_at at time zone 'UTC')::date
on conflict (user_id, block_id, day) do update set clicks = excluded.clicks;

-- Raw events are intentionally short-lived; aggregates stay forever. The
-- function is batched so deletes never hold a large table lock.
create or replace function public.prune_analytics_raw(
  p_before timestamptz default now() - interval '90 days',
  p_batch_size integer default 25000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_views integer := 0;
  deleted_clicks integer := 0;
begin
  if p_batch_size < 1 or p_batch_size > 100000 then
    raise exception 'batch size must be between 1 and 100000';
  end if;
  with victims as (
    select id from public.profile_views where created_at < p_before limit p_batch_size
  )
  delete from public.profile_views where id in (select id from victims);
  get diagnostics deleted_views = row_count;

  with victims as (
    select id from public.block_clicks where created_at < p_before limit p_batch_size
  )
  delete from public.block_clicks where id in (select id from victims);
  get diagnostics deleted_clicks = row_count;

  return jsonb_build_object('views', deleted_views, 'clicks', deleted_clicks);
end;
$$;

revoke all on function public.prune_analytics_raw(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.prune_analytics_raw(timestamptz, integer) to service_role;

-- Supabase Cron is available on hosted projects. Running hourly drains up to
-- 600k old rows per table per day while keeping each transaction bounded.
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'bento-prune-analytics-raw') then
    perform cron.schedule(
      'bento-prune-analytics-raw',
      '17 * * * *',
      'select public.prune_analytics_raw(now() - interval ''90 days'', 25000)'
    );
  end if;
end;
$$;
