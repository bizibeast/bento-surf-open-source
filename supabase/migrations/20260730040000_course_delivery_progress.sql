-- Keep course delivery in one canonical lesson table and persist learner
-- completion against the private access grant. Product settings remain the
-- creator-facing editing format, while this trigger makes delivery updates
-- atomic with every product insert/update.

create or replace function public.sync_commerce_course_lessons()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lesson jsonb;
  ordinal bigint;
  lesson_id uuid;
  lesson_ids uuid[] := array[]::uuid[];
  lesson_type text;
begin
  if new.kind::text <> 'course' then
    delete from public.commerce_course_lessons where product_id = new.id;
    return new;
  end if;

  if jsonb_typeof(coalesce(new.settings -> 'lessons', '[]'::jsonb)) <> 'array' then
    raise exception 'Course lessons must be an array';
  end if;

  for lesson, ordinal in
    select value, ordinality
    from jsonb_array_elements(coalesce(new.settings -> 'lessons', '[]'::jsonb))
      with ordinality
  loop
    if coalesce(lesson ->> 'id', '') ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    then
      lesson_id := (lesson ->> 'id')::uuid;
    else
      lesson_id := md5(
        new.id::text || ':' || ordinal::text || ':' || coalesce(lesson ->> 'title', '')
      )::uuid;
    end if;

    lesson_type := case lesson ->> 'contentType'
      when 'video' then 'video'
      when 'file' then 'file'
      when 'link' then 'link'
      else 'text'
    end;
    lesson_ids := array_append(lesson_ids, lesson_id);

    insert into public.commerce_course_lessons(
      id,
      product_id,
      creator_id,
      module_title,
      position,
      title,
      summary,
      content_type,
      content,
      is_preview
    )
    values (
      lesson_id,
      new.id,
      new.creator_id,
      coalesce(nullif(trim(lesson ->> 'moduleTitle'), ''), 'Course'),
      ordinal - 1,
      coalesce(nullif(trim(lesson ->> 'title'), ''), 'Untitled lesson'),
      coalesce(lesson ->> 'summary', ''),
      lesson_type,
      jsonb_strip_nulls(jsonb_build_object(
        'body', nullif(lesson ->> 'body', ''),
        'url', nullif(lesson ->> 'url', '')
      )),
      coalesce((lesson ->> 'isPreview')::boolean, false)
    )
    on conflict (id) do update
      set module_title = excluded.module_title,
          position = excluded.position,
          title = excluded.title,
          summary = excluded.summary,
          content_type = excluded.content_type,
          content = excluded.content,
          is_preview = excluded.is_preview,
          updated_at = now()
      where commerce_course_lessons.product_id = excluded.product_id
        and commerce_course_lessons.creator_id = excluded.creator_id;
  end loop;

  delete from public.commerce_course_lessons
    where product_id = new.id
      and not (id = any(lesson_ids));

  return new;
end;
$$;

drop trigger if exists commerce_products_sync_course_lessons on public.commerce_products;
create trigger commerce_products_sync_course_lessons
  after insert or update of kind, settings on public.commerce_products
  for each row execute function public.sync_commerce_course_lessons();

revoke all on function public.sync_commerce_course_lessons() from public, anon, authenticated;

-- Backfill products created before the synchronization trigger existed.
update public.commerce_products
  set settings = settings
  where kind::text = 'course';

create table if not exists public.commerce_course_progress (
  access_grant_id uuid not null
    references public.commerce_access_grants(id) on delete cascade,
  lesson_id uuid not null
    references public.commerce_course_lessons(id) on delete cascade,
  completed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (access_grant_id, lesson_id)
);

create index if not exists commerce_course_progress_lesson_idx
  on public.commerce_course_progress(lesson_id);

alter table public.commerce_course_progress enable row level security;
revoke all on public.commerce_course_progress from public, anon, authenticated;
grant all on public.commerce_course_progress to service_role;

create trigger commerce_course_progress_updated_at
  before update on public.commerce_course_progress
  for each row execute function public.tg_set_updated_at();

create or replace function public.set_commerce_course_lesson_progress(
  p_access_grant_id uuid,
  p_lesson_id uuid,
  p_completed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  grant_row public.commerce_access_grants%rowtype;
  lesson_row public.commerce_course_lessons%rowtype;
begin
  select *
    into grant_row
    from public.commerce_access_grants
    where id = p_access_grant_id
    for update;

  if grant_row.id is null
    or grant_row.status::text <> 'active'
    or (grant_row.expires_at is not null and grant_row.expires_at <= now())
  then
    raise exception 'Course access is not active';
  end if;

  select *
    into lesson_row
    from public.commerce_course_lessons
    where id = p_lesson_id
      and product_id = grant_row.product_id;

  if lesson_row.id is null then
    raise exception 'Course lesson was not found';
  end if;

  if p_completed then
    insert into public.commerce_course_progress(access_grant_id, lesson_id, completed_at)
      values (grant_row.id, lesson_row.id, now())
      on conflict (access_grant_id, lesson_id) do update
        set completed_at = excluded.completed_at,
            updated_at = now();
  else
    delete from public.commerce_course_progress
      where access_grant_id = grant_row.id
        and lesson_id = lesson_row.id;
  end if;

  return jsonb_build_object(
    'access_grant_id', grant_row.id,
    'lesson_id', lesson_row.id,
    'completed', p_completed,
    'completed_at', case when p_completed then now() else null end
  );
end;
$$;

revoke all on function public.set_commerce_course_lesson_progress(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_commerce_course_lesson_progress(uuid, uuid, boolean)
  to service_role;

comment on table public.commerce_course_progress is
  'Durable learner completion state scoped to a private commerce access grant.';
comment on function public.sync_commerce_course_lessons() is
  'Atomically synchronizes creator-edited course settings into canonical delivery lessons.';
comment on function public.set_commerce_course_lesson_progress(uuid, uuid, boolean) is
  'Service-only course completion transition that validates active access and lesson ownership.';
