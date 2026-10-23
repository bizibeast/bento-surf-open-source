-- Run with psql -v ON_ERROR_STOP=1 in an EMPTY disposable local database.
-- Includes the existing signal feedback function to exercise the real lock path.
begin;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.profiles(id uuid primary key);
create table public.content_agent_threads(id uuid primary key,user_id uuid,content_revision bigint not null default 0, unique(id,user_id));
create table public.content_agent_messages(id uuid primary key default gen_random_uuid(),user_id uuid not null,thread_id uuid not null,role text not null,content text not null default '',payload jsonb not null default '{}',expires_at timestamptz not null default now()+interval '180 days',foreign key(thread_id,user_id) references public.content_agent_threads(id,user_id));
create table public.social_posts(id uuid primary key,user_id uuid not null,title text,body text not null,status text not null,settings jsonb not null default '{}',cancelled_at timestamptz,updated_at timestamptz not null default now());
create table public.social_post_targets(id uuid primary key default gen_random_uuid(),post_id uuid not null references public.social_posts(id),status text not null,next_attempt_at timestamptz,lease_expires_at timestamptz);
create table public.content_agent_signals(id uuid primary key,user_id uuid not null,message_id uuid,status text,topic_keys text[],feedback text);
create table public.content_agent_topic_preferences(user_id uuid,signal_id uuid,topic_key text,unique(user_id,signal_id,topic_key));
create function public.bump_content_thread_revision() returns trigger language plpgsql as $$begin update public.content_agent_threads set content_revision=content_revision+1 where id=new.thread_id; return null; end;$$;
create trigger content_messages_revision after insert or update on public.content_agent_messages for each row execute function public.bump_content_thread_revision();
insert into public.profiles values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.content_agent_threads values ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001',0);
grant usage on schema public to service_role;
grant select,insert,update,delete on all tables in schema public to service_role;

create function public.feedback_content_agent_signal(p_user_id uuid,p_message_id uuid,p_feedback text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare s public.content_agent_signals;
begin
 if p_feedback not in ('useful','not_relevant','less_like_this') then raise exception 'Invalid feedback'; end if;
 perform 1 from public.profiles where id=p_user_id for update;
 select * into s from public.content_agent_signals where user_id=p_user_id and message_id=p_message_id and status='delivered' for update;
 if not found or (p_feedback='less_like_this' and cardinality(s.topic_keys)=0) then return false; end if;
 update public.content_agent_messages set payload=jsonb_set(payload,'{proactive,feedback}',to_jsonb(p_feedback))
   where id=p_message_id and user_id=p_user_id and role='assistant' and expires_at>now();
 if not found then return false; end if;
 delete from public.content_agent_topic_preferences where user_id=p_user_id and signal_id=s.id;
 if p_feedback='less_like_this' then
   insert into public.content_agent_topic_preferences(user_id,signal_id,topic_key)
     select p_user_id,s.id,key from unnest(s.topic_keys[1:8]) key on conflict do nothing;
 end if;
 update public.content_agent_signals set feedback=p_feedback where id=s.id;
 return true;
end;
$$;
-- Dependencies for the guarded existing mutation and image admission functions.
create table public.content_agent_preferences(user_id uuid primary key,generate_images boolean default true,use_face_references boolean default false,reference_photo_ids uuid[] default '{}');
create table public.content_agent_image_jobs(id uuid primary key default gen_random_uuid(),user_id uuid,request_key text,message_id uuid,card_id text,draft_revision integer,target_slide_index integer default 0,prompt text,reference_ids uuid[] default '{}',request_source text default 'agent',references_confirmed boolean default false,status text default 'queued',lease_until timestamptz,lease_key uuid,created_at timestamptz default now(),updated_at timestamptz default now(),output_count integer default 0,completed_at timestamptz,detail text,task_id text,unique(user_id,request_key));
create table public.content_agent_media(id uuid primary key,user_id uuid,storage_key text,mime_type text,byte_size bigint,source text,message_id uuid,card_id text,draft_revision integer,slide_index integer);
create table public.creator_content_media(id uuid primary key,user_id uuid,status text,storage_key text,mime_type text,byte_size bigint);
create function public.content_agent_image_quota(p_user_id uuid) returns jsonb language sql as $$ select jsonb_build_object('successful',0,'pending',count(*) filter(where status<>'failed')) from public.content_agent_image_jobs where user_id=p_user_id $$;
create function public.prepare_content_agent_destinations(p_user_id uuid,p_post_id uuid) returns void language sql as $$ select $$;

\ir ../migrations/20261022141659_agent_draft_rejection_state.sql
do $$
declare owner_id uuid := '00000000-0000-4000-8000-000000000001'; thread_id uuid := '00000000-0000-4000-8000-000000000010'; mid uuid; pid uuid; outcome integer; item integer; expected_status text; actual_status text; invalid_mid uuid;
begin
 for item in 1..10 loop
  mid:=gen_random_uuid(); pid:=gen_random_uuid();
  expected_status:=case item when 1 then 'cancelled' when 2 then 'draft' when 3 then 'scheduled' when 4 then 'published' when 5 then 'draft' when 6 then 'draft' when 7 then 'draft' when 8 then 'draft' when 9 then 'draft' when 10 then 'draft' end;
  insert into public.social_posts values(pid,case when item=8 then '00000000-0000-4000-8000-000000000002'::uuid else owner_id end,case when item=6 then 'edited title' else 'Original' end,case when item=2 then 'Edited body' else 'Original body' end,case item when 3 then 'scheduled' when 4 then 'published' else 'draft' end,jsonb_build_object('routineRunId',case when item=5 then 'other-run' else 'run-1' end),null,now());
  insert into public.social_post_targets(post_id,status,next_attempt_at,lease_expires_at) values(pid,'pending',now(),now()+interval '1 hour'),(pid,'published',null,null);
  insert into public.content_agent_messages(id,user_id,thread_id,role,payload) values(mid,owner_id,thread_id,'assistant',jsonb_build_object('cards',jsonb_build_array(jsonb_build_object('type','draft','cardId','card-1','body','Original body')),'proactive',jsonb_build_object('draftBindings',case when item=7 then '[]'::jsonb else jsonb_build_array(jsonb_build_object('cardId','card-1','socialPostId',pid,'body','Original body','title','Original','runId','run-1','postUpdatedAt',case when item=10 then null else now() end)) end)));
  if item=9 then update public.social_posts set settings=settings||'{"mediaEdited":true}',updated_at=now()+interval '1 second' where id=pid; end if;
  if public.reject_content_agent_draft('00000000-0000-4000-8000-000000000002',mid,'card-1','no')<>-1 then raise exception 'Cross-owner rejected'; end if;
  if public.reject_content_agent_draft(owner_id,mid,'other-card','no')<>-1 then raise exception 'Missing card rejected'; end if;
  outcome:=public.reject_content_agent_draft(owner_id,mid,'card-1','No thank you');
  if outcome<>1 then raise exception 'Valid reject failed case %',item; end if;
  if public.reject_content_agent_draft(owner_id,mid,'card-1','No thank you')<>0 then raise exception 'Duplicate rejection not idempotent'; end if;
  if (select count(*) from public.content_agent_messages where payload#>>'{feedback,messageId}'=mid::text)<>1 then raise exception 'Duplicate/missing rejection event'; end if;
  if not (select payload->'rejectedDraftIds' ? 'card-1' from public.content_agent_messages where id=mid) then raise exception 'Rejection not durable'; end if;
  select status into actual_status from public.social_posts where id=pid;
  if actual_status<>expected_status then raise exception 'Wrong post status in case %: % expected %',item,actual_status,expected_status; end if;
  if (select count(*) from public.social_post_targets where post_id=pid and status='published')<>1 then raise exception 'Published target changed'; end if;
  if item=1 and not exists(select from public.social_post_targets where post_id=pid and status='cancelled' and next_attempt_at is null and lease_expires_at is null) then raise exception 'Pending target not cancelled'; end if;
  if item<>1 and not exists(select from public.social_post_targets where post_id=pid and status='pending' and next_attempt_at is not null) then raise exception 'Independent target changed'; end if;
 end loop;
 insert into public.content_agent_messages(id,user_id,thread_id,role,payload,expires_at) values(gen_random_uuid(),owner_id,thread_id,'assistant','{"cards":[{"type":"draft","cardId":"expired"}]}',now()-interval '1 day') returning id into invalid_mid;
 if public.reject_content_agent_draft(owner_id,invalid_mid,'expired','no')<>-1 then raise exception 'Expired artifact rejected'; end if;
 if has_function_privilege('anon','public.reject_content_agent_draft(uuid,uuid,text,text)','execute') or has_function_privilege('authenticated','public.reject_content_agent_draft(uuid,uuid,text,text)','execute') then raise exception 'Public rejection RPC exposed'; end if;
 if not has_function_privilege('service_role','public.reject_content_agent_draft(uuid,uuid,text,text)','execute') then raise exception 'Service role rejected'; end if;
 raise notice 'PASS: owner/card binding, idempotent single event, durable rejection, exact unchanged draft cancellation, preserve edits/title/run/owner/status/unbound/media-only/legacy copies, preserve published targets, expiry, restricted grants';
end $$;

-- Mutations use actual production SQL, with media branches available but empty.
alter table public.content_agent_messages add column created_at timestamptz default now();
alter table public.social_posts add column media jsonb default '[]';
alter table public.social_posts add column timezone text default 'UTC';
do $$
declare owner_id uuid:='00000000-0000-4000-8000-000000000001'; thread_id uuid:='00000000-0000-4000-8000-000000000010'; mid uuid; pid uuid; stamp timestamptz; state jsonb; job jsonb; queued uuid; accepted uuid; count_before integer; operation text;
begin
 insert into public.content_agent_preferences(user_id) values(owner_id);
 pid:=gen_random_uuid(); mid:=gen_random_uuid(); stamp:=clock_timestamp();
 insert into public.social_posts(id,user_id,title,body,status,settings,updated_at) values(pid,owner_id,'Original','Original body','draft','{"routineRunId":"run-1"}',stamp);
 insert into public.content_agent_messages(id,user_id,thread_id,role,payload) values(mid,owner_id,thread_id,'assistant',jsonb_build_object(
  'cards',jsonb_build_array(jsonb_build_object('type','draft','cardId','card-1','platform','twitter','format','post','title','Original','body','Original body')),
  'draftStates',jsonb_build_object('card-1',jsonb_build_object('revision',0,'postUpdatedAt',stamp)),
  'proactive',jsonb_build_object('draftBindings',jsonb_build_array(jsonb_build_object('cardId','card-1','socialPostId',pid,'body','Original body','title','Original','runId','run-1','postUpdatedAt',stamp)))));
 state:=public.mutate_content_agent_draft(owner_id,mid,'card-1',0,'edit','{"body":"Edited inside Benny"}');
 if (select (payload#>>'{proactive,draftBindings,0,postUpdatedAt}')::timestamptz from public.content_agent_messages where id=mid) is distinct from (state->>'postUpdatedAt')::timestamptz then raise exception 'Agent edit did not advance the bound snapshot'; end if;
 if public.reject_content_agent_draft(owner_id,mid,'card-1','Not a fit')<>1 then raise exception 'Current edited Agent artifact rejection failed'; end if;
 if (select status from public.social_posts where id=pid)<>'cancelled' then raise exception 'Current edited Agent artifact did not cancel its unchanged canonical draft'; end if;
 mid:=gen_random_uuid();
 insert into public.content_agent_messages(id,user_id,thread_id,role,payload) values(mid,owner_id,thread_id,'assistant','{"cards":[{"type":"draft","cardId":"card-1","platform":"twitter","format":"post","title":"Original","body":"Original body"}]}');
 job:=public.reserve_content_agent_image(owner_id,'queued-before-reject',1,jsonb_build_object('messageId',mid,'cardId','card-1','revision',0),'An editorial tree'); queued:=(job->>'id')::uuid;
 job:=public.reserve_content_agent_image(owner_id,'accepted-before-reject',1,jsonb_build_object('messageId',mid,'cardId','card-1','revision',0),'An editorial tree'); accepted:=(job->>'id')::uuid;
 update public.content_agent_image_jobs set status='submitted',task_id='already-accepted' where id=accepted;
 perform public.reject_content_agent_draft(owner_id,mid,'card-1','Not a fit');
 select count(*) into count_before from public.social_posts;
 foreach operation in array array['edit','prepare','handoff','attach','background'] loop
  begin
   perform public.mutate_content_agent_draft(owner_id,mid,'card-1',0,operation,'{"body":"Do not resurrect this"}');
   raise exception 'Rejected mutation accepted: %',operation;
  exception when others then if sqlerrm<>'This draft was rejected' then raise; end if; end;
 end loop;
 if (select count(*) from public.social_posts)<>count_before then raise exception 'Rejected handoff created a Scheduler copy'; end if;
 begin
  perform public.reserve_content_agent_image(owner_id,'after-reject',1,jsonb_build_object('messageId',mid,'cardId','card-1','revision',0),'A rejected request');
  raise exception 'Rejected image was reserved';
 exception when others then if sqlerrm<>'Owned draft unavailable' then raise; end if; end;
 if public.claim_content_agent_image(owner_id,queued) is not null then raise exception 'Rejected queued image may submit'; end if;
 if (select status from public.content_agent_image_jobs where id=queued)<>'failed' then raise exception 'Rejected queued image not released'; end if;
 if public.claim_content_agent_image(owner_id,accepted)->>'status'<>'submitted' then raise exception 'Already-paid image cannot reconcile'; end if;
 raise notice 'PASS: rejected prepare/edit/handoff/attach blocked, updated bound snapshot, queued image rejection, preserve accepted image reconciliation';
end $$;

rollback;
