-- Explore is opt-in plus founder approval. Opt-in stays on by default.
-- Review uses home-grid cards only (page_id is null). A page is queued
-- after it has more than 3 of those cards.

alter table public.profiles
  add column if not exists explore_review_status text not null default 'none',
  add column if not exists explore_opted_in_at timestamptz,
  add column if not exists explore_reviewed_at timestamptz,
  add column if not exists explore_reviewed_by uuid references auth.users(id) on delete set null;

alter table public.profiles
  drop constraint if exists profiles_explore_review_status_check;

alter table public.profiles
  add constraint profiles_explore_review_status_check
  check (explore_review_status in ('none', 'pending', 'approved', 'rejected'));

comment on column public.profiles.show_in_explore is
  'Creator opt-in for Explore. Default is on. Listing still requires more than 3 home cards and founder approval.';
comment on column public.profiles.explore_review_status is
  'Founder review state for Explore: none, pending, approved, or rejected.';
comment on column public.profiles.explore_opted_in_at is
  'When this page last entered the Explore review queue.';
comment on column public.profiles.explore_reviewed_at is
  'When a founder last approved or rejected this Explore listing.';
comment on column public.profiles.explore_reviewed_by is
  'Founder who last approved or rejected this Explore listing.';

create or replace function public.explore_home_card_count(p_user_id uuid)
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.blocks
  where user_id = p_user_id
    and page_id is null;
$$;

revoke all on function public.explore_home_card_count(uuid)
  from public, anon, authenticated;
grant execute on function public.explore_home_card_count(uuid) to service_role;

create or replace function public.compute_explore_review_state(
  p_show_in_explore boolean,
  p_was_opted_in boolean,
  p_status text,
  p_opted_in_at timestamptz,
  p_card_count integer
)
returns table (
  next_status text,
  next_opted_in_at timestamptz,
  clear_review boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  ready boolean := coalesce(p_card_count, 0) > 3;
  just_opted_in boolean := p_show_in_explore is true and p_was_opted_in is not true;
begin
  if p_show_in_explore is not true then
    if p_status = 'approved' then
      next_status := 'approved';
      next_opted_in_at := p_opted_in_at;
      clear_review := false;
    else
      next_status := 'none';
      next_opted_in_at := null;
      clear_review := true;
    end if;
    return next;
  end if;

  if p_status = 'approved' then
    next_status := 'approved';
    next_opted_in_at := p_opted_in_at;
    clear_review := false;
    return next;
  end if;

  if just_opted_in then
    if ready then
      next_status := 'pending';
      next_opted_in_at := now();
      clear_review := true;
    else
      next_status := 'none';
      next_opted_in_at := null;
      clear_review := true;
    end if;
    return next;
  end if;

  if p_status = 'rejected' then
    next_status := 'rejected';
    next_opted_in_at := p_opted_in_at;
    clear_review := false;
    return next;
  end if;

  if ready then
    if p_status = 'pending' then
      next_status := 'pending';
      next_opted_in_at := p_opted_in_at;
      clear_review := false;
    else
      next_status := 'pending';
      next_opted_in_at := now();
      clear_review := false;
    end if;
    return next;
  end if;

  next_status := 'none';
  next_opted_in_at := null;
  clear_review := false;
  return next;
end;
$$;

revoke all on function public.compute_explore_review_state(boolean, boolean, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.compute_explore_review_state(boolean, boolean, text, timestamptz, integer)
  to service_role;

create or replace function public.apply_explore_review_state(
  p_show_in_explore boolean,
  p_was_opted_in boolean,
  p_status text,
  p_opted_in_at timestamptz,
  p_reviewed_at timestamptz,
  p_reviewed_by uuid,
  p_card_count integer
)
returns table (
  explore_review_status text,
  explore_opted_in_at timestamptz,
  explore_reviewed_at timestamptz,
  explore_reviewed_by uuid
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    computed.next_status,
    computed.next_opted_in_at,
    case when computed.clear_review then null else p_reviewed_at end,
    case when computed.clear_review then null else p_reviewed_by end
  from public.compute_explore_review_state(
    p_show_in_explore,
    p_was_opted_in,
    p_status,
    p_opted_in_at,
    p_card_count
  ) as computed;
$$;

revoke all on function public.apply_explore_review_state(boolean, boolean, text, timestamptz, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.apply_explore_review_state(boolean, boolean, text, timestamptz, timestamptz, uuid, integer)
  to service_role;

-- Keep pages that already qualify for Explore live. Thin pages wait until they
-- have more than 3 home cards and pass review.
update public.profiles as profile
set
  explore_review_status = 'approved',
  explore_opted_in_at = coalesce(profile.updated_at, now()),
  explore_reviewed_at = now()
where profile.show_in_explore = true
  and profile.onboarded = true
  and profile.noindex = false
  and public.explore_home_card_count(profile.id) > 3;

update public.profiles as profile
set
  explore_review_status = 'pending',
  explore_opted_in_at = coalesce(profile.explore_opted_in_at, profile.updated_at, now())
where profile.show_in_explore = true
  and profile.explore_review_status = 'none'
  and public.explore_home_card_count(profile.id) > 3;

alter table public.profiles
  alter column show_in_explore set default true;

drop index if exists public.profiles_explore_directory_idx;
create index profiles_explore_directory_idx
  on public.profiles (explore_category, updated_at desc)
  where show_in_explore = true
    and explore_review_status = 'approved'
    and onboarded = true
    and noindex = false;

create index if not exists profiles_explore_review_queue_idx
  on public.profiles (explore_opted_in_at desc)
  where show_in_explore = true
    and explore_review_status = 'pending';

create index if not exists blocks_explore_home_cards_idx
  on public.blocks (user_id)
  where page_id is null;

create or replace function public.sync_explore_review_on_opt_in()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_state record;
begin
  select *
  into next_state
  from public.apply_explore_review_state(
    new.show_in_explore,
    case when tg_op = 'INSERT' then false else old.show_in_explore end,
    coalesce(new.explore_review_status, 'none'),
    new.explore_opted_in_at,
    new.explore_reviewed_at,
    new.explore_reviewed_by,
    public.explore_home_card_count(new.id)
  );

  new.explore_review_status := next_state.explore_review_status;
  new.explore_opted_in_at := next_state.explore_opted_in_at;
  new.explore_reviewed_at := next_state.explore_reviewed_at;
  new.explore_reviewed_by := next_state.explore_reviewed_by;
  return new;
end;
$$;

revoke all on function public.sync_explore_review_on_opt_in()
  from public, anon, authenticated;
grant execute on function public.sync_explore_review_on_opt_in() to service_role;

drop trigger if exists profiles_sync_explore_review_on_opt_in on public.profiles;
create trigger profiles_sync_explore_review_on_opt_in
  before insert or update of show_in_explore
  on public.profiles
  for each row execute function public.sync_explore_review_on_opt_in();

create or replace function public.sync_explore_review_profile(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_row public.profiles%rowtype;
  next_state record;
begin
  select * into current_row from public.profiles where id = p_user_id;
  if not found then return; end if;

  select *
  into next_state
  from public.apply_explore_review_state(
    current_row.show_in_explore,
    current_row.show_in_explore,
    current_row.explore_review_status,
    current_row.explore_opted_in_at,
    current_row.explore_reviewed_at,
    current_row.explore_reviewed_by,
    public.explore_home_card_count(p_user_id)
  );

  if next_state.explore_review_status is not distinct from current_row.explore_review_status
    and next_state.explore_opted_in_at is not distinct from current_row.explore_opted_in_at
    and next_state.explore_reviewed_at is not distinct from current_row.explore_reviewed_at
    and next_state.explore_reviewed_by is not distinct from current_row.explore_reviewed_by
  then
    return;
  end if;

  update public.profiles
  set
    explore_review_status = next_state.explore_review_status,
    explore_opted_in_at = next_state.explore_opted_in_at,
    explore_reviewed_at = next_state.explore_reviewed_at,
    explore_reviewed_by = next_state.explore_reviewed_by
  where id = p_user_id;
end;
$$;

create or replace function public.sync_explore_review_on_card_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_user uuid;
begin
  target_user := coalesce(new.user_id, old.user_id);
  perform public.sync_explore_review_profile(target_user);

  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    perform public.sync_explore_review_profile(old.user_id);
  end if;

  return null;
end;
$$;

revoke all on function public.sync_explore_review_on_card_change()
  from public, anon, authenticated;
revoke all on function public.sync_explore_review_profile(uuid)
  from public, anon, authenticated;
grant execute on function public.sync_explore_review_on_card_change() to service_role;
grant execute on function public.sync_explore_review_profile(uuid) to service_role;

drop trigger if exists blocks_sync_explore_review_on_card_change on public.blocks;
create trigger blocks_sync_explore_review_on_card_change
  after insert or delete or update of page_id, user_id
  on public.blocks
  for each row execute function public.sync_explore_review_on_card_change();

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
  with home_cards as (
    select block.user_id, count(*)::integer as card_count
    from public.blocks as block
    where block.page_id is null
    group by block.user_id
  ),
  eligible as (
    select
      profile.username,
      profile.display_name,
      profile.bio,
      profile.avatar_url,
      profile.explore_category,
      profile.updated_at,
      coalesce(totals.views, 0)::bigint as visit_count
    from public.profiles as profile
    join home_cards on home_cards.user_id = profile.id
    left join public.profile_visit_totals as totals
      on totals.user_id = profile.id
    where profile.show_in_explore = true
      and profile.explore_review_status = 'approved'
      and profile.onboarded = true
      and profile.noindex = false
      and home_cards.card_count > 3
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
  'Server-only Explore directory: opted in, founder-approved, more than 3 home cards, ranked by lifetime profile visits.';

create or replace function public.get_founder_explore_reviews(
  p_queue text,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  explore_category text,
  show_in_explore boolean,
  onboarded boolean,
  noindex boolean,
  card_count integer,
  explore_review_status text,
  explore_opted_in_at timestamptz,
  explore_reviewed_at timestamptz,
  updated_at timestamptz,
  email text,
  total_count bigint,
  pending_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with home_cards as (
    select block.user_id, count(*)::integer as card_count
    from public.blocks as block
    where block.page_id is null
    group by block.user_id
  ),
  pending as (
    select count(*)::bigint as pending_count
    from public.profiles as profile
    left join home_cards on home_cards.user_id = profile.id
    where profile.show_in_explore = true
      and profile.explore_review_status in ('none', 'pending')
      and coalesce(home_cards.card_count, 0) > 3
  ),
  eligible as (
    select
      profile.id as user_id,
      profile.username,
      profile.display_name,
      profile.bio,
      profile.avatar_url,
      profile.explore_category,
      profile.show_in_explore,
      profile.onboarded,
      profile.noindex,
      coalesce(home_cards.card_count, 0) as card_count,
      profile.explore_review_status,
      profile.explore_opted_in_at,
      profile.explore_reviewed_at,
      profile.updated_at,
      target_user.email::text as email
    from public.profiles as profile
    join auth.users as target_user on target_user.id = profile.id
    left join home_cards on home_cards.user_id = profile.id
    where case p_queue
      when 'pending' then
        profile.show_in_explore = true
        and profile.explore_review_status in ('none', 'pending')
        and coalesce(home_cards.card_count, 0) > 3
      when 'live' then
        profile.show_in_explore = true
        and profile.explore_review_status = 'approved'
      when 'rejected' then
        profile.explore_review_status = 'rejected'
      else false
    end
  ),
  counted as (
    select eligible.*, count(*) over ()::bigint as total_count
    from eligible
  ),
  paged as (
    select counted.*
    from counted
    order by
      case p_queue
        when 'pending' then coalesce(counted.explore_opted_in_at, counted.updated_at)
        else coalesce(counted.explore_reviewed_at, counted.updated_at)
      end desc nulls last,
      counted.username asc
    limit least(greatest(p_limit, 1), 100)
    offset greatest(p_offset, 0)
  )
  select
    paged.user_id,
    paged.username,
    paged.display_name,
    paged.bio,
    paged.avatar_url,
    paged.explore_category,
    paged.show_in_explore,
    paged.onboarded,
    paged.noindex,
    paged.card_count,
    paged.explore_review_status,
    paged.explore_opted_in_at,
    paged.explore_reviewed_at,
    paged.updated_at,
    paged.email,
    coalesce(paged.total_count, 0)::bigint as total_count,
    pending.pending_count
  from pending
  left join paged on true
  -- LIMIT in paged uses this order; repeat it so the join cannot reshuffle the page.
  order by
    case p_queue
      when 'pending' then coalesce(paged.explore_opted_in_at, paged.updated_at)
      else coalesce(paged.explore_reviewed_at, paged.updated_at)
    end desc nulls last,
    paged.username asc;
$$;

revoke all on function public.get_founder_explore_reviews(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_founder_explore_reviews(text, integer, integer)
  to service_role;

comment on function public.get_founder_explore_reviews(text, integer, integer) is
  'Server-only founder Explore review queues. Pending is opted-in home pages with more than 3 cards, newest first.';

grant select (explore_review_status)
  on public.profiles to authenticated;

notify pgrst, 'reload schema';
