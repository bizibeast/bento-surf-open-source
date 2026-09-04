-- Analytics dates are creator-local rather than UTC-only. The preference is
-- initially populated by the application from Cloudflare's IP timezone and can
-- be changed by the creator at any time.

alter table public.profiles
  add column if not exists analytics_timezone text;

alter table public.profiles
  drop constraint if exists profiles_analytics_timezone_length;

alter table public.profiles
  add constraint profiles_analytics_timezone_length
  check (
    analytics_timezone is null
    or char_length(analytics_timezone) between 1 and 100
  );

drop function if exists public.get_creator_analytics(date);

create or replace function public.get_creator_analytics(
  p_start_date date default null,
  p_timezone text default 'UTC'
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with settings as (
    select
      auth.uid() as user_id,
      case
        when exists (
          select 1 from pg_catalog.pg_timezone_names
          where name = p_timezone
        ) then p_timezone
        else 'UTC'
      end as time_zone
  ), bounds as (
    select
      settings.*,
      case
        when p_start_date is null then null
        else p_start_date::timestamp at time zone settings.time_zone
      end as start_at
    from settings
  ), recent_view_rows as (
    select view.*,
      (view.created_at at time zone bounds.time_zone)::date as local_day,
      extract(hour from view.created_at at time zone bounds.time_zone)::integer as local_hour
    from public.profile_views view, bounds
    where p_start_date is not null
      and view.user_id = bounds.user_id
      and view.created_at >= bounds.start_at
  ), recent_click_rows as (
    select click.*,
      (click.created_at at time zone bounds.time_zone)::date as local_day
    from public.block_clicks click, bounds
    where p_start_date is not null
      and click.user_id = bounds.user_id
      and click.created_at >= bounds.start_at
  ), recent_daily_views as (
    select
      local_day as day,
      count(*)::bigint as views,
      count(distinct visitor_hash) filter (
        where visitor_hash is not null and visitor_hash <> ''
      )::bigint as unique_visitors
    from recent_view_rows
    group by local_day
  ), recent_daily_clicks as (
    select local_day as day, count(*)::bigint as clicks
    from recent_click_rows
    group by local_day
  ), recent_daily as (
    select
      coalesce(views.day, clicks.day) as day,
      coalesce(views.views, 0)::bigint as views,
      coalesce(clicks.clicks, 0)::bigint as clicks,
      coalesce(views.unique_visitors, 0)::bigint as unique_visitors
    from recent_daily_views views
    full join recent_daily_clicks clicks using (day)
  ), all_daily as (
    select
      (analytics.bucket_start at time zone bounds.time_zone)::date as day,
      sum(analytics.views)::bigint as views,
      sum(analytics.clicks)::bigint as clicks,
      0::bigint as unique_visitors
    from public.analytics_hourly analytics, bounds
    where p_start_date is null
      and analytics.user_id = bounds.user_id
    group by 1
  ), daily_rows as (
    select * from recent_daily
    union all
    select * from all_daily
  ), recent_hourly as (
    select local_hour as hour, count(*)::bigint as views
    from recent_view_rows
    group by local_hour
  ), all_hourly as (
    select
      extract(hour from analytics.bucket_start at time zone bounds.time_zone)::integer as hour,
      sum(analytics.views)::bigint as views
    from public.analytics_hourly analytics, bounds
    where p_start_date is null
      and analytics.user_id = bounds.user_id
    group by 1
  ), hourly_totals as (
    select * from recent_hourly
    union all
    select * from all_hourly
  ), recent_dimension_totals as (
    select item.dimension, left(item.value, 160) as value, count(*)::bigint as count
    from recent_view_rows row
    cross join lateral (
      values
        ('device', row.device),
        ('browser', row.browser),
        ('country', row.country),
        ('city', row.city),
        ('source', row.source)
    ) as item(dimension, value)
    where item.value is not null and item.value <> ''
    group by item.dimension, left(item.value, 160)
  ), all_dimension_totals as (
    select analytics.dimension, analytics.value, sum(analytics.count)::bigint as count
    from public.analytics_daily_dimensions analytics, bounds
    where p_start_date is null
      and analytics.user_id = bounds.user_id
    group by analytics.dimension, analytics.value
  ), dimension_totals as (
    select * from recent_dimension_totals
    union all
    select * from all_dimension_totals
  ), recent_block_totals as (
    select block_id, count(*)::bigint as clicks
    from recent_click_rows
    group by block_id
  ), all_block_totals as (
    select analytics.block_id, sum(analytics.clicks)::bigint as clicks
    from public.analytics_block_daily analytics, bounds
    where p_start_date is null
      and analytics.user_id = bounds.user_id
    group by analytics.block_id
  ), block_totals as (
    select * from recent_block_totals
    union all
    select * from all_block_totals
  ), total_uniques as (
    select coalesce(sum(unique_visitors), 0)::bigint as count
    from recent_daily
    where p_start_date is not null
    union all
    select coalesce(sum(analytics.unique_visitors), 0)::bigint as count
    from public.analytics_daily analytics, bounds
    where p_start_date is null
      and analytics.user_id = bounds.user_id
  )
  select jsonb_build_object(
    'totalViews', coalesce((select sum(views) from daily_rows), 0),
    'totalClicks', coalesce((select sum(clicks) from daily_rows), 0),
    'uniqueVisitors', coalesce((select sum(count) from total_uniques), 0),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day,
        'views', views,
        'clicks', clicks,
        'uniqueVisitors', unique_visitors
      ) order by day)
      from daily_rows
    ), '[]'::jsonb),
    'hourly', (
      select jsonb_agg(coalesce(hourly_totals.views, 0) order by series.hour)
      from generate_series(0, 23) as series(hour)
      left join hourly_totals on hourly_totals.hour = series.hour
    ),
    'dimensions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dimension', dimension,
        'value', value,
        'count', count
      ) order by dimension, count desc)
      from dimension_totals
    ), '[]'::jsonb),
    'blockClicks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'blockId', block_id,
        'clicks', clicks
      ) order by clicks desc)
      from block_totals
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_creator_analytics(date, text) from public, anon;
grant execute on function public.get_creator_analytics(date, text) to authenticated, service_role;
