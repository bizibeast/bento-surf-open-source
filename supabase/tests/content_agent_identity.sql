-- Run after the identity migration in a transaction; the runner rolls back everything.
insert into public.profiles(id, username) values
  ('10000000-0000-4000-8000-000000000001', 'identity_workspace_one'),
  ('10000000-0000-4000-8000-000000000002', 'identity_workspace_two');
insert into auth.users(id, email) values ('20000000-0000-4000-8000-000000000001', 'identity_contract_actor@example.test');
insert into public.workspace_memberships(auth_user_id, workspace_id, role, status) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner', 'active');

insert into public.content_agent_threads(user_id, title, last_message_at)
select '10000000-0000-4000-8000-000000000001', 'Legacy chat ' || n, now() - interval '1 hour'
from generate_series(1, 65) n;

-- Migration boundary: the runner applies schema here, after legacy fixtures.
set local role service_role;
do $$
declare a uuid := '10000000-0000-4000-8000-000000000001'; b uuid := '10000000-0000-4000-8000-000000000002';
  state jsonb; thread uuid; other uuid; first_page jsonb; second_page jsonb; rendered uuid;
begin
  state := public.ensure_content_named_agent(a); thread := (state->'thread'->>'id')::uuid;
  if state->'preferences'->>'display_name' <> 'Bento' then raise exception 'Bad default name'; end if;
  if state->'preferences'->'platforms' <> '["twitter","linkedin","instagram"]'::jsonb then raise exception 'Bad platform defaults'; end if;
  if state->'preferences'->>'generate_images' <> 'false' or state->'preferences'->>'use_face_references' <> 'false' then raise exception 'Opt-ins must default off'; end if;
  if public.ensure_content_named_agent(a)->'thread'->>'id' <> thread::text then raise exception 'Identity is not idempotent'; end if;
  other := (public.ensure_content_named_agent(b)->'thread'->>'id')::uuid;
  if other = thread then raise exception 'Workspace identities collide'; end if;
  begin
    insert into public.content_agent_threads(user_id, title, kind) values (a, 'duplicate', 'agent');
    raise exception 'Uniqueness not enforced';
  exception when unique_violation then null; end;
  if (select count(*) from public.content_agent_threads where user_id = a and kind = 'chat') <> 65 then raise exception 'Legacy chat converted'; end if;

  first_page := public.list_content_agent_threads_page(a, 50);
  second_page := public.list_content_agent_threads_page(a, 50, first_page->'nextCursor');
  if jsonb_array_length(first_page->'chats') <> 50 or jsonb_array_length(second_page->'chats') <> 15 then raise exception 'Chats beyond page one missing'; end if;
  if second_page->'nextCursor' <> 'null'::jsonb then raise exception 'Final page cursor incorrect'; end if;
  if exists(select 1 from jsonb_array_elements(first_page->'chats') x join jsonb_array_elements(second_page->'chats') y on x->>'id'=y->>'id') then raise exception 'Cursor duplicates tied timestamps'; end if;
  if exists(select 1 from jsonb_array_elements(first_page->'chats') x where x->>'user_id' <> a::text) then raise exception 'Cross workspace list leak'; end if;

  insert into public.content_agent_messages(user_id, thread_id, role, content, created_at, expires_at) values
    (a, thread, 'assistant', 'retained unread', now() - interval '1 minute', now() + interval '180 days'),
    (a, thread, 'assistant', 'expired', now() - interval '190 days', now() - interval '10 days'),
    (a, thread, 'user', 'not unread', now() - interval '1 minute', now() + interval '180 days'),
    (a, thread, 'system_event', 'not unread either', now() - interval '1 minute', now() + interval '180 days');
  if (public.ensure_content_named_agent(a)->'thread'->>'unread_count')::int <> 1 then raise exception 'Unread role/retention filtering failed'; end if;
  state := public.set_content_agent_thread_state(a, thread, null, true);
  if (state->>'unread_count')::int <> 0 or state->>'last_read_at' is null then raise exception 'Read watermark failed'; end if;
  insert into public.content_agent_messages(user_id, thread_id, role, content, created_at) values (a, thread, 'assistant', 'after watermark', now() + interval '1 second');
  if (public.ensure_content_named_agent(a)->'thread'->>'unread_count')::int <> 1 then raise exception 'Messages after read lost'; end if;
  select id into rendered from public.content_agent_messages where user_id = a and thread_id = thread and content = 'after watermark';
  insert into public.content_agent_messages(user_id, thread_id, role, content, created_at) values (a, thread, 'assistant', 'arrived after render', now() + interval '2 seconds');
  state := public.set_content_agent_thread_state(a, thread, null, true, rendered);
  if (state->>'unread_count')::int <> 1 then raise exception 'Render watermark cleared newer unread message'; end if;
  if public.set_content_agent_thread_state(a, other, null, true, rendered) is not null then raise exception 'Cross thread message read allowed'; end if;
  if public.set_content_agent_thread_state(b, other, null, true, rendered) is not null then raise exception 'Cross workspace message read allowed'; end if;
  select id into rendered from public.content_agent_messages where user_id = a and thread_id = thread and content = 'expired';
  if public.set_content_agent_thread_state(a, thread, null, true, rendered) is not null then raise exception 'Expired message advanced read watermark'; end if;
  if public.set_content_agent_thread_state(a, other, true) is not null then raise exception 'Cross workspace pin succeeded'; end if;
  if public.set_content_agent_thread_state(a, thread, true)->>'pinned_at' is null then raise exception 'Pin failed'; end if;
  if public.set_content_agent_thread_state(a, thread, false)->>'pinned_at' is not null then raise exception 'Unpin failed'; end if;
  -- Pinned chats precede recent unpinned chats, and cursor still traverses both groups.
  perform public.set_content_agent_thread_state(a, (second_page->'chats'->14->>'id')::uuid, true);
  first_page := public.list_content_agent_threads_page(a, 1);
  if first_page->'chats'->0->>'pinned_at' is null then raise exception 'Pinned chat ordering failed'; end if;
  second_page := public.list_content_agent_threads_page(a, 100, first_page->'nextCursor');
  if jsonb_array_length(second_page->'chats') <> 64 then raise exception 'Pinned cursor transition failed'; end if;

  state := public.update_content_agent_preferences(a, '{"display_name":"Miso","platforms":["linkedin"],"generate_images":true}');
  if state->'thread'->>'title' <> 'Miso' or state->'preferences'->>'display_name' <> 'Miso' then raise exception 'Atomic rename failed'; end if;
  if state->'preferences'->>'use_face_references' <> 'false' then raise exception 'Image opt-in granted face consent'; end if;
  state := public.update_content_agent_preferences(a, '{"use_face_references":true}');
  state := public.update_content_agent_preferences(a, '{"generate_images":false}');
  if state->'preferences'->>'use_face_references' <> 'false' then raise exception 'Disabled generation retained face consent'; end if;
  begin
    perform public.update_content_agent_preferences(a, '{"use_face_references":true}');
    raise exception 'Face references accepted with generation disabled';
  exception when raise_exception then
    if sqlerrm = 'Face references accepted with generation disabled' then raise; end if;
  end;
  begin
    perform public.update_content_agent_preferences(a, '{"display_name":""}');
    raise exception 'Unsafe name accepted';
  exception when check_violation then null; end;
  if public.ensure_content_named_agent(a)->'thread'->>'title' <> 'Miso' then raise exception 'Rejected rename changed identity'; end if;
  if public.ensure_content_named_agent(b)->'preferences'->>'display_name' <> 'Bento' then raise exception 'Cross workspace rename'; end if;
  if (select column_default from information_schema.columns where table_schema='public' and table_name='content_agent_messages' and column_name='expires_at') not like '%180 days%' then raise exception 'Retention changed'; end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
declare n integer;
begin
  select count(*) into n from public.content_agent_preferences;
  if n <> 1 then raise exception 'RLS exposed another workspace or denied member workspace'; end if;
  update public.content_agent_preferences set proactive_paused = true where user_id = '10000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Cross workspace update allowed'; end if;
  begin
    update public.content_agent_preferences set user_id = '10000000-0000-4000-8000-000000000002';
    raise exception 'RLS allowed reassignment';
  exception when insufficient_privilege then null; end;
  begin
    perform public.ensure_content_named_agent('10000000-0000-4000-8000-000000000002');
    raise exception 'Authenticated role executed server-only RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'Content agent identity SQL checks passed' as result;
