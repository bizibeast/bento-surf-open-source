begin;

alter table public.pages
  add column system text,
  add column is_visible boolean not null default true;

alter table public.pages
  drop constraint if exists pages_user_id_slug_key;

create unique index if not exists pages_user_id_custom_slug_unique
  on public.pages (user_id, slug)
  where system is null;

alter table public.pages
  drop constraint if exists pages_system_check,
  add constraint pages_system_check
    check (system is null or system in ('calendar', 'store', 'insights', 'newsletter')),
  drop constraint if exists pages_system_url_check,
  add constraint pages_system_url_check check (system is null or url is null),
  drop constraint if exists pages_system_slug_check,
  add constraint pages_system_slug_check
    check (system is null or slug = '__system_' || system) not valid,
  drop constraint if exists pages_custom_slug_system_namespace_check,
  add constraint pages_custom_slug_system_namespace_check
    check (system is not null or slug !~ '^__system_') not valid;

create unique index if not exists pages_user_id_system_unique
  on public.pages (user_id, system)
  where system is not null;

create table public.page_system_item_layouts (
  page_id uuid not null references public.pages(id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 120),
  x integer not null check (x between 0 and 7),
  y integer not null check (y between 0 and 10000),
  w integer not null check (w between 1 and 8),
  h integer not null check (h between 1 and 1000),
  position integer not null check (position between 0 and 199),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (page_id, item_key)
);

create index page_system_item_layouts_page_position_idx
  on public.page_system_item_layouts (page_id, position);

alter table public.page_system_item_layouts enable row level security;

create policy page_system_item_layouts_public_read
  on public.page_system_item_layouts for select
  to anon, authenticated
  using (true);

create policy page_system_item_layouts_owner_insert
  on public.page_system_item_layouts for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  );

create policy page_system_item_layouts_owner_update
  on public.page_system_item_layouts for update
  to authenticated
  using (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  );

create policy page_system_item_layouts_owner_delete
  on public.page_system_item_layouts for delete
  to authenticated
  using (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  );

revoke all on public.page_system_item_layouts from public, anon;
grant select on public.page_system_item_layouts to anon, authenticated;
grant insert, update, delete on public.page_system_item_layouts to authenticated;
grant all on public.page_system_item_layouts to service_role;

create trigger page_system_item_layouts_updated_at
  before update on public.page_system_item_layouts
  for each row execute function public.tg_set_updated_at();

with system_pages as (
  select profile.id as user_id, 'calendar'::text as system, 'Calendar'::text as name, '__system_calendar'::text as slug, 1 as page_order
  from public.profiles profile
  where profile.calendar_page_enabled
  union all
  select profile.id as user_id, 'store'::text as system, 'Store'::text as name, '__system_store'::text as slug, 2 as page_order
  from public.profiles profile
  where profile.store_page_enabled
  union all
  select profile.id as user_id, 'insights'::text as system, 'Insights'::text as name, '__system_insights'::text as slug, 3 as page_order
  from public.profiles profile
  where profile.social_insights_enabled
  union all
  select profile.id as user_id, 'newsletter'::text as system, 'Newsletters'::text as name, '__system_newsletter'::text as slug, 4 as page_order
  from public.profiles profile
  where exists (
    select 1
    from public.newsletter_publications publication
    where publication.creator_id = profile.id
      and publication.status = 'published'
  )
), ranked_system_pages as (
  select *, row_number() over (partition by user_id order by page_order) as page_offset
  from system_pages
)
insert into public.pages (user_id, name, slug, position, system, is_visible, url)
select system_page.user_id,
  system_page.name,
  system_page.slug,
  coalesce((select max(page.position) from public.pages page where page.user_id = system_page.user_id), -1) + system_page.page_offset,
  system_page.system,
  true,
  null
from ranked_system_pages system_page
on conflict (user_id, system) where system is not null do nothing;

create function public.reorder_creator_pages(page_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  visible_page_ids uuid[];
begin
  if actor_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if page_ids is null
    or array_position(page_ids, null) is not null
    or (select count(distinct page_id) from unnest(page_ids) as requested(page_id)) <> cardinality(page_ids) then
    raise exception 'Page ids must be a complete, unique list.' using errcode = '22023';
  end if;

  select coalesce(array_agg(locked_pages.id order by locked_pages.position, locked_pages.id), '{}')
    into visible_page_ids
  from (
    select page.id, page.position
    from public.pages page
    where page.user_id = actor_id
      and page.is_visible
    for update
  ) locked_pages;

  if cardinality(page_ids) <> cardinality(visible_page_ids)
    or not (page_ids <@ visible_page_ids)
    or not (visible_page_ids <@ page_ids) then
    raise exception 'Page ids must include every owned visible page.' using errcode = '22023';
  end if;

  with requested as (
    select page_id, ordinality - 1 as position
    from unnest(page_ids) with ordinality as ids(page_id, ordinality)
  )
  update public.pages page
  set position = requested.position
  from requested
  where page.id = requested.page_id
    and page.user_id = actor_id;
end;
$$;

create function public.replace_page_system_item_layout(
  target_page_id uuid,
  layout_items jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if target_page_id is null
    or layout_items is null
    or jsonb_typeof(layout_items) <> 'array'
    or jsonb_array_length(layout_items) > 200 then
    raise exception 'Layout items must be an array of at most 200 items.' using errcode = '22023';
  end if;

  perform 1
  from public.pages page
  where page.id = target_page_id
    and page.user_id = actor_id
    and page.is_visible
    and page.system is not null
  for update;

  if not found then
    raise exception 'System page not found.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(layout_items) as input(item)
    where jsonb_typeof(item) <> 'object'
      or not (item ? 'item_key' and item ? 'x' and item ? 'y' and item ? 'w' and item ? 'h' and item ? 'position')
      or jsonb_typeof(item->'item_key') <> 'string'
      or char_length(item->>'item_key') not between 1 and 120
      or not case when jsonb_typeof(item->'x') = 'number' and (item->>'x') ~ '^\d+$' then (item->>'x')::integer between 0 and 7 else false end
      or not case when jsonb_typeof(item->'y') = 'number' and (item->>'y') ~ '^\d+$' then (item->>'y')::integer between 0 and 10000 else false end
      or not case when jsonb_typeof(item->'w') = 'number' and (item->>'w') ~ '^\d+$' then (item->>'w')::integer between 1 and 8 else false end
      or not case when jsonb_typeof(item->'h') = 'number' and (item->>'h') ~ '^\d+$' then (item->>'h')::integer between 1 and 1000 else false end
      or not case when jsonb_typeof(item->'position') = 'number' and (item->>'position') ~ '^\d+$' then (item->>'position')::integer between 0 and 199 else false end
  ) then
    raise exception 'Layout items contain invalid grid values.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(layout_items) as input(item)
    group by item->>'item_key'
    having count(*) > 1
  ) then
    raise exception 'Layout item keys must be unique.' using errcode = '22023';
  end if;

  delete from public.page_system_item_layouts layout
  where layout.page_id = target_page_id
    and not exists (
      select 1
      from jsonb_array_elements(layout_items) as input(item)
      where input.item->>'item_key' = layout.item_key
    );

  insert into public.page_system_item_layouts (page_id, item_key, x, y, w, h, position)
  select target_page_id, item_key, x, y, w, h, position
  from jsonb_to_recordset(layout_items) as item(
    item_key text,
    x integer,
    y integer,
    w integer,
    h integer,
    position integer
  )
  on conflict (page_id, item_key) do update
  set x = excluded.x,
    y = excluded.y,
    w = excluded.w,
    h = excluded.h,
    position = excluded.position;
end;
$$;

revoke all on function public.reorder_creator_pages(uuid[]) from public, anon;
revoke all on function public.replace_page_system_item_layout(uuid, jsonb) from public, anon;
grant execute on function public.reorder_creator_pages(uuid[]) to authenticated;
grant execute on function public.replace_page_system_item_layout(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
