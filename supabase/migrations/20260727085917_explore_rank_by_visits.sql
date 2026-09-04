-- Explore must stay deterministic and fast as analytics volume grows. Keep a
-- compact lifetime view counter instead of summing the daily analytics table
-- on every public directory request.
create table if not exists public.profile_visit_totals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  views bigint not null default 0 check (views >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists profile_visit_totals_ranking_idx
  on public.profile_visit_totals (views desc, user_id);

alter table public.profile_visit_totals enable row level security;

revoke all on table public.profile_visit_totals from public, anon, authenticated;
grant all on table public.profile_visit_totals to service_role;

-- Backfill from the bounded daily rollups, which contain the complete
-- historical view count after the analytics rollout migration.
insert into public.profile_visit_totals (user_id, views, updated_at)
select user_id, sum(views)::bigint, now()
from public.analytics_daily
group by user_id
on conflict (user_id) do update
set views = excluded.views,
    updated_at = excluded.updated_at;

create or replace function public.update_profile_visit_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile_visit_totals (user_id, views, updated_at)
  select user_id, count(*)::bigint, now()
  from inserted_profile_views
  group by user_id
  on conflict (user_id) do update
  set views = public.profile_visit_totals.views + excluded.views,
      updated_at = excluded.updated_at;

  return null;
end;
$$;

revoke all on function public.update_profile_visit_totals() from public, anon, authenticated;

drop trigger if exists profile_visit_totals_rollup on public.profile_views;
create trigger profile_visit_totals_rollup
  after insert on public.profile_views
  referencing new table as inserted_profile_views
  for each statement execute function public.update_profile_visit_totals();

-- This function is server-only. It applies eligibility, search, ranking, and
-- pagination in one query so clients cannot accidentally expose empty pages or
-- reorder a partial result set.
create or replace function public.get_explore_profiles(
  p_category text default null,
  p_query text default '',
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  username text,
  display_name text,
  bio text,
  avatar_url text,
  explore_category text,
  updated_at timestamptz,
  visit_count bigint,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with eligible as (
    select
      profile.username,
      profile.display_name,
      profile.bio,
      profile.avatar_url,
      profile.explore_category,
      profile.updated_at,
      coalesce(totals.views, 0)::bigint as visit_count
    from public.profiles as profile
    left join public.profile_visit_totals as totals
      on totals.user_id = profile.id
    where profile.show_in_explore = true
      and profile.onboarded = true
      and profile.noindex = false
      and exists (
        select 1
        from public.blocks as block
        where block.user_id = profile.id
      )
      and (p_category is null or profile.explore_category = p_category)
      and (
        coalesce(p_query, '') = ''
        or profile.username ilike '%' || p_query || '%'
        or profile.display_name ilike '%' || p_query || '%'
      )
  ),
  counted as (
    select eligible.*, count(*) over ()::bigint as total_count
    from eligible
  )
  select
    counted.username,
    counted.display_name,
    counted.bio,
    counted.avatar_url,
    counted.explore_category,
    counted.updated_at,
    counted.visit_count,
    counted.total_count
  from counted
  order by counted.visit_count desc, counted.updated_at desc, counted.username asc
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.get_explore_profiles(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_explore_profiles(text, text, integer, integer)
  to service_role;

comment on function public.get_explore_profiles(text, text, integer, integer) is
  'Server-only Explore directory: at least one block, ranked by lifetime profile visits.';
