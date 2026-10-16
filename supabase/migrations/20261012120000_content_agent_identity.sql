begin;

alter table public.content_agent_threads
  add column kind text not null default 'chat' check (kind in ('agent', 'chat')),
  add column pinned_at timestamptz,
  add column last_read_at timestamptz;

create unique index content_agent_one_named_thread
  on public.content_agent_threads(user_id) where kind = 'agent';
create index content_agent_chat_sidebar_idx
  on public.content_agent_threads(user_id, (coalesce(pinned_at, '-infinity'::timestamptz)) desc, last_message_at desc, id desc)
  where kind = 'chat';
create index content_agent_unread_assistant_idx
  on public.content_agent_messages(user_id, thread_id, created_at) where role = 'assistant';

create table public.content_agent_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  display_name text not null default 'Bento'
    check (length(display_name) between 1 and 80 and display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  proactive_paused boolean not null default false,
  generate_images boolean not null default false,
  use_face_references boolean not null default false,
  platforms text[] not null default array['twitter', 'linkedin', 'instagram']::text[]
    check (platforms <@ array['twitter', 'linkedin', 'instagram']::text[] and cardinality(platforms) <= 3 and array_position(platforms, null) is null),
  check (generate_images or not use_face_references)
);
alter table public.content_agent_preferences enable row level security;
revoke all on public.content_agent_preferences from public, anon;
grant select, insert, update, delete on public.content_agent_preferences to authenticated;
grant all on public.content_agent_preferences to service_role;
create policy workspace_member_access on public.content_agent_preferences for all to authenticated
  using (private.is_workspace_member(user_id))
  with check (private.is_workspace_member(user_id));

-- Internal RPCs use invoker rights and are callable only by the trusted server.
-- A workspace profile lock serializes creation and rename so thread title and
-- preferences always agree, including simultaneous first visits and jobs.
create function public.ensure_content_named_agent(p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare prefs public.content_agent_preferences; thread public.content_agent_threads;
begin
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then raise exception 'Content workspace is unavailable'; end if;
  insert into public.content_agent_preferences(user_id) values (p_user_id) on conflict do nothing;
  select * into prefs from public.content_agent_preferences where user_id = p_user_id;
  insert into public.content_agent_threads(user_id, title, kind)
    values (p_user_id, prefs.display_name, 'agent')
    on conflict (user_id) where kind = 'agent' do nothing;
  select * into thread from public.content_agent_threads where user_id = p_user_id and kind = 'agent';
  return jsonb_build_object('preferences', to_jsonb(prefs), 'thread', to_jsonb(thread) || jsonb_build_object('unread_count', (
    select count(*) from public.content_agent_messages m where m.user_id = p_user_id and m.thread_id = thread.id
      and m.role = 'assistant' and m.expires_at > now() and (thread.last_read_at is null or m.created_at > thread.last_read_at)
  )));
end;
$$;

create function public.update_content_agent_preferences(p_user_id uuid, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare images boolean; face_refs boolean;
begin
  perform public.ensure_content_named_agent(p_user_id);
  select coalesce((p_patch->>'generate_images')::boolean, generate_images),
         coalesce((p_patch->>'use_face_references')::boolean, use_face_references)
    into images, face_refs from public.content_agent_preferences where user_id = p_user_id;
  if not images and (p_patch->>'use_face_references')::boolean is true then
    raise exception 'Enable image generation before using face references';
  end if;
  update public.content_agent_preferences set
    display_name = coalesce(p_patch->>'display_name', display_name),
    proactive_paused = coalesce((p_patch->>'proactive_paused')::boolean, proactive_paused),
    generate_images = images,
    use_face_references = images and face_refs,
    platforms = case when p_patch ? 'platforms' then array(select jsonb_array_elements_text(p_patch->'platforms')) else platforms end
    where user_id = p_user_id;
  update public.content_agent_threads set title = (select display_name from public.content_agent_preferences where user_id = p_user_id)
    where user_id = p_user_id and kind = 'agent';
  return public.ensure_content_named_agent(p_user_id);
end;
$$;

create function public.list_content_agent_threads_page(p_user_id uuid, p_limit integer default 50, p_cursor jsonb default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare state jsonb; rows jsonb; last_row jsonb; next_cursor jsonb;
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'Invalid page size'; end if;
  state := public.ensure_content_named_agent(p_user_id);
  select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object('unread_count', (
    select count(*) from public.content_agent_messages m where m.user_id = p_user_id and m.thread_id = t.id
      and m.role = 'assistant' and m.expires_at > now() and (t.last_read_at is null or m.created_at > t.last_read_at)
  )) order by coalesce(t.pinned_at, '-infinity'::timestamptz) desc, t.last_message_at desc, t.id desc), '[]'::jsonb)
  into rows from (
    select * from public.content_agent_threads
      where user_id = p_user_id and kind = 'chat' and (
        p_cursor is null or
        (coalesce(pinned_at, '-infinity'::timestamptz), last_message_at, id) <
        (coalesce((p_cursor->>'pinnedAt')::timestamptz, '-infinity'::timestamptz), (p_cursor->>'lastMessageAt')::timestamptz, (p_cursor->>'id')::uuid)
      )
      order by coalesce(pinned_at, '-infinity'::timestamptz) desc, last_message_at desc, id desc limit p_limit + 1
  ) t;
  if jsonb_array_length(rows) > p_limit then
    rows := rows - p_limit;
    last_row := rows->(p_limit - 1);
    next_cursor := jsonb_build_object('pinnedAt', last_row->'pinned_at', 'lastMessageAt', last_row->'last_message_at', 'id', last_row->'id');
  end if;
  return jsonb_build_object('agent', state->'thread', 'chats', rows, 'nextCursor', next_cursor);
end;
$$;

create function public.set_content_agent_thread_state(p_user_id uuid, p_thread_id uuid, p_pinned boolean default null, p_mark_read boolean default false, p_through_message_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare thread public.content_agent_threads; read_through timestamptz := now();
begin
  if p_mark_read and p_through_message_id is not null then
    select created_at into read_through from public.content_agent_messages
      where id = p_through_message_id and user_id = p_user_id and thread_id = p_thread_id and expires_at > now();
    if not found then return null; end if;
  end if;
  update public.content_agent_threads t set
    pinned_at = case when p_pinned is null then t.pinned_at when p_pinned then coalesce(t.pinned_at, now()) else null end,
    last_read_at = case when p_mark_read then greatest(coalesce(t.last_read_at, '-infinity'::timestamptz), read_through) else t.last_read_at end
    where t.user_id = p_user_id and t.id = p_thread_id returning * into thread;
  if not found then return null; end if;
  return to_jsonb(thread) || jsonb_build_object('unread_count', (
    select count(*) from public.content_agent_messages m where m.user_id = p_user_id and m.thread_id = thread.id
      and m.role = 'assistant' and m.expires_at > now() and (thread.last_read_at is null or m.created_at > thread.last_read_at)
  ));
end;
$$;

revoke all on function public.ensure_content_named_agent(uuid) from public, anon, authenticated;
revoke all on function public.update_content_agent_preferences(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.list_content_agent_threads_page(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.set_content_agent_thread_state(uuid, uuid, boolean, boolean, uuid) from public, anon, authenticated;
grant execute on function public.ensure_content_named_agent(uuid) to service_role;
grant execute on function public.update_content_agent_preferences(uuid, jsonb) to service_role;
grant execute on function public.list_content_agent_threads_page(uuid, integer, jsonb) to service_role;
grant execute on function public.set_content_agent_thread_state(uuid, uuid, boolean, boolean, uuid) to service_role;
commit;
