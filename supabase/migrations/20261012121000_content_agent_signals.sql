begin;

create table public.content_agent_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('fresh_source','schedule_gap','prepared_routine')),
  fingerprint text not null,
  source_ids text[] not null,
  source_keys text[] not null default '{}',
  topic_keys text[] not null default '{}',
  observed_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','delivered','skipped','failed')),
  next_attempt_at timestamptz not null default now(),
  lease_key uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  message_id uuid,
  delivered_at timestamptz,
  feedback text check (feedback in ('useful','not_relevant','less_like_this')),
  unique(user_id, fingerprint)
);
create index content_agent_signals_due on public.content_agent_signals(next_attempt_at) where status in ('pending','processing');
create index content_agent_signals_budget on public.content_agent_signals(user_id, delivered_at);
create index content_agent_signals_sources on public.content_agent_signals using gin(source_keys);
alter table public.content_agent_signals enable row level security;
revoke all on public.content_agent_signals from public, anon, authenticated;
grant all on public.content_agent_signals to service_role;

-- Event-fed fair queue, independent of feature cohort size. No all-workspace scan.
create table public.content_agent_scan_queue (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  next_check_at timestamptz not null default now()
);
alter table public.content_agent_scan_queue enable row level security;
revoke all on public.content_agent_scan_queue from public, anon, authenticated;
grant all on public.content_agent_scan_queue to service_role;
create function public.queue_content_agent_scan() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.content_agent_scan_queue(user_id) values(new.user_id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger discover_proactive_scan after insert or update on public.creator_content_recommendations
  for each row execute function public.queue_content_agent_scan();
create trigger routine_proactive_scan after update of prepared_output on public.content_routine_runs
  for each row when (new.prepared_output is not null) execute function public.queue_content_agent_scan();
-- One-time bootstrap is bounded by existing data; subsequent ticks use the durable queue.
insert into public.content_agent_scan_queue(user_id)
 select user_id from public.content_routine_runs where prepared_output is not null
 union select user_id from public.creator_content_recommendations on conflict do nothing;

-- Source/event identities, source feedback and topic preferences have separate lifetimes.
create table public.content_agent_topic_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  signal_id uuid not null references public.content_agent_signals(id) on delete cascade,
  topic_key text not null check(length(topic_key) between 1 and 120),
  primary key(user_id,signal_id,topic_key)
);
create index content_agent_topic_lookup on public.content_agent_topic_preferences(user_id,topic_key);
alter table public.content_agent_topic_preferences enable row level security;
revoke all on public.content_agent_topic_preferences from public,anon,authenticated;
grant all on public.content_agent_topic_preferences to service_role;

alter table public.creator_content_recommendations add column agent_source_key text, add column agent_checked_at timestamptz;
create index content_agent_recommendation_index_pending on public.creator_content_recommendations(user_id,id) where agent_source_key is null;
create index content_agent_recommendation_progress on public.creator_content_recommendations(user_id,agent_checked_at nulls first,id);
create index content_agent_recommendation_feedback on public.creator_content_recommendations(user_id,agent_source_key)
  where feedback in ('saved','not_relevant') or metadata->>'saved'='true';
create function public.invalidate_content_agent_source_index() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='INSERT' or new.source_url is distinct from old.source_url or new.fingerprint is distinct from old.fingerprint then
   new.agent_source_key:=null; new.agent_checked_at:=null;
 end if;
 -- The normal updated_at trigger runs first. Index-only bookkeeping must not reorder Discover.
 if TG_OP='UPDATE' and (new.agent_source_key is distinct from old.agent_source_key or new.agent_checked_at is distinct from old.agent_checked_at)
   and (to_jsonb(new)-'agent_source_key'-'agent_checked_at'-'updated_at') = (to_jsonb(old)-'agent_source_key'-'agent_checked_at'-'updated_at') then
   new.updated_at:=old.updated_at;
 end if;
 return new;
end;
$$;
create trigger invalidate_content_agent_source_index before insert or update on public.creator_content_recommendations
 for each row execute function public.invalidate_content_agent_source_index();

-- Normalization is done by shared JS discoverPostKey, never a second SQL URL parser.
create function public.unindexed_content_agent_sources(p_user_id uuid)
returns setof public.creator_content_recommendations language sql security invoker set search_path='' as $$
 select r.* from public.creator_content_recommendations r where user_id=p_user_id and agent_source_key is null
 order by (feedback in ('saved','not_relevant') or coalesce(metadata->>'saved'='true',false)) desc,id limit 200;
$$;
create function public.index_content_agent_sources(p_user_id uuid,p_rows jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare row jsonb;
begin
 if jsonb_array_length(p_rows)>200 then raise exception 'Source index batch is too large'; end if;
 perform 1 from public.profiles where id=p_user_id for update;
 for row in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
   update public.creator_content_recommendations set agent_source_key=row->>'sourceKey'
   where user_id=p_user_id and id=(row->>'id')::uuid and agent_source_key is null
     and source_url is not distinct from row->>'sourceUrl' and fingerprint=row->>'fingerprint';
 end loop;
end;
$$;
create function public.content_agent_source_available(p_user_id uuid,p_source_key text)
returns boolean language sql security invoker set search_path='' as $$
 select not exists(select 1 from public.creator_content_recommendations where user_id=p_user_id
   and (feedback in ('saved','not_relevant') or metadata->>'saved'='true')
   and (agent_source_key is null or agent_source_key=p_source_key));
$$;
create function public.claim_content_agent_recommendations(p_user_id uuid)
returns setof public.creator_content_recommendations language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.profiles where id=p_user_id for update;
 -- Unknown negative/saved identities are normalized first, regardless of candidate page.
 if exists(select 1 from public.creator_content_recommendations where user_id=p_user_id and agent_source_key is null
   and (feedback in ('saved','not_relevant') or metadata->>'saved'='true')) then return; end if;
 return query with due as (
   select id from public.creator_content_recommendations where user_id=p_user_id and agent_source_key is not null
   order by agent_checked_at nulls first,id limit 200 for update
 ), touched as (
   update public.creator_content_recommendations r set agent_checked_at=clock_timestamp() from due where r.id=due.id returning r.*
 ) select touched.* from touched where public.content_agent_source_available(p_user_id,touched.agent_source_key);
end;
$$;
create function public.get_content_agent_source(p_user_id uuid,p_source_key text)
returns setof public.creator_content_recommendations language sql security invoker set search_path='' as $$
 select r.* from public.creator_content_recommendations r where user_id=p_user_id and agent_source_key=p_source_key
   and public.content_agent_source_available(p_user_id,p_source_key)
 order by source_published_at desc nulls last,id limit 20;
$$;
create function public.content_agent_suppressed_sources(p_user_id uuid,p_keys text[])
returns setof text language sql security invoker set search_path='' as $$
 select distinct key from public.content_agent_signals s cross join lateral unnest(s.source_keys) key
 where s.user_id=p_user_id and s.feedback='not_relevant' and key=any(p_keys[1:1600]);
$$;
create function public.content_agent_suppressed_topics(p_user_id uuid,p_keys text[])
returns setof text language sql security invoker set search_path='' as $$
 select distinct topic_key from public.content_agent_topic_preferences where user_id=p_user_id and topic_key=any(p_keys[1:1600]);
$$;
revoke all on function public.invalidate_content_agent_source_index(),public.unindexed_content_agent_sources(uuid),public.index_content_agent_sources(uuid,jsonb),public.content_agent_source_available(uuid,text),public.claim_content_agent_recommendations(uuid),public.get_content_agent_source(uuid,text),public.content_agent_suppressed_topics(uuid,text[]),public.content_agent_suppressed_sources(uuid,text[]) from public,anon,authenticated;
grant execute on function public.unindexed_content_agent_sources(uuid),public.index_content_agent_sources(uuid,jsonb),public.content_agent_source_available(uuid,text),public.claim_content_agent_recommendations(uuid),public.get_content_agent_source(uuid,text),public.content_agent_suppressed_topics(uuid,text[]),public.content_agent_suppressed_sources(uuid,text[]) to service_role;

create function public.claim_content_agent_scans(p_limit integer default 3)
returns setof uuid language plpgsql security invoker set search_path = '' as $$
begin
 return query with due as (
   select user_id from public.content_agent_scan_queue where next_check_at <= now()
     order by next_check_at, user_id for update skip locked limit greatest(1,least(p_limit,10))
 ) update public.content_agent_scan_queue q set next_check_at = now()+interval '1 hour'
   from due where q.user_id=due.user_id returning q.user_id;
end;
$$;

create function public.enqueue_content_agent_signal(p_user_id uuid,p_kind text,p_fingerprint text,p_source_ids text[],p_observed_at timestamptz)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare result uuid;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then return null; end if;
 insert into public.content_agent_signals(user_id,kind,fingerprint,source_ids,observed_at)
   values(p_user_id,p_kind,p_fingerprint,p_source_ids,p_observed_at)
   on conflict(user_id,fingerprint) do nothing;
 select id into result from public.content_agent_signals where user_id=p_user_id and fingerprint=p_fingerprint;
 return result;
end;
$$;

-- Lock order: profile -> preferences -> signals -> canonical posts -> named thread/messages.
-- Network work never holds a transaction. Each active lease is a delivery reservation.
create function public.claim_due_content_agent_signals(p_limit integer default 1)
returns setof public.content_agent_signals language plpgsql security invoker set search_path = '' as $$
declare ws uuid; s public.content_agent_signals; n integer := 0; paused boolean;
begin
 for ws in select p.id from public.profiles p join lateral (
   select min(next_attempt_at) due from public.content_agent_signals where user_id=p.id
     and status in ('pending','processing') and next_attempt_at<=now()
     and (lease_until is null or lease_until<=now())
 ) d on d.due is not null order by d.due,p.id for update of p skip locked limit greatest(1,least(p_limit,5))*10
 loop
   select proactive_paused into paused from public.content_agent_preferences where user_id=ws for update;
   if exists(select 1 from public.profiles where id=ws and workspace_status<>'active') then paused:=true; end if;
   select * into s from public.content_agent_signals where user_id=ws and status in ('pending','processing')
     and next_attempt_at<=now() and (lease_until is null or lease_until<=now())
     order by next_attempt_at,id limit 1 for update;
   if not found then continue; end if;
   if s.observed_at<now()-interval '7 days' or s.attempts>=3 or exists(
     select 1 from public.content_agent_signals f where f.user_id=ws and f.feedback='not_relevant' and f.source_keys && case when s.kind='fresh_source' then s.source_ids else '{}'::text[] end
   ) then
     update public.content_agent_signals set status='skipped',lease_key=null,lease_until=null where id=s.id;
     continue;
   end if;
   if coalesce(paused,false) or not public.bento_has_hosted_access(ws)
   or (s.kind='fresh_source' and exists(select 1 from public.creator_content_recommendations where user_id=ws and agent_source_key is null and (feedback in ('saved','not_relevant') or metadata->>'saved'='true'))) or exists(
     select 1 from public.content_agent_signals where user_id=ws and
       (delivered_at>now()-interval '24 hours' or (status='processing' and lease_until>now()))
   ) or (select count(*) from public.content_agent_signals where user_id=ws and
       (delivered_at>now()-interval '7 days' or (status='processing' and lease_until>now())))>=3 then
     update public.content_agent_signals set next_attempt_at=now()+interval '1 hour',status='pending',lease_key=null,lease_until=null where id=s.id;
     continue;
   end if;
   update public.content_agent_signals set status='processing',lease_key=gen_random_uuid(),lease_until=now()+interval '2 minutes',
     next_attempt_at=now()+interval '2 minutes',attempts=attempts+1 where id=s.id returning * into s;
   return next s;
   n:=n+1;
   exit when n>=greatest(1,least(p_limit,5));
 end loop;
end;
$$;

create function public.finish_content_agent_signal(p_user_id uuid,p_signal_id uuid,p_lease_key uuid,p_payload jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare s public.content_agent_signals; identity jsonb; mid uuid; binding jsonb; paused boolean;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then return null; end if;
 select proactive_paused into paused from public.content_agent_preferences where user_id=p_user_id for update;
 if exists(select 1 from public.profiles where id=p_user_id and workspace_status<>'active') then paused:=true; end if;
 select * into s from public.content_agent_signals where id=p_signal_id and user_id=p_user_id for update;
 if not found then return null; end if;
 if s.status='delivered' then return s.message_id; end if;
 if s.status<>'processing' or s.lease_key is distinct from p_lease_key or s.lease_until<=now() then return null; end if;
 if coalesce(paused,false) or not public.bento_has_hosted_access(p_user_id) or s.observed_at<now()-interval '7 days'
 or exists(select 1 from public.content_agent_signals f where f.user_id=p_user_id and f.feedback='not_relevant' and f.source_keys && array(select jsonb_array_elements_text(coalesce(p_payload#>'{proactive,sourceKeys}','[]'::jsonb))))
 or exists(select 1 from public.content_agent_topic_preferences t where t.user_id=p_user_id and t.topic_key=any(array(select jsonb_array_elements_text(coalesce(p_payload#>'{proactive,topicKeys}','[]'::jsonb)))))
 or exists(select 1 from public.content_agent_signals where user_id=p_user_id and id<>s.id and (delivered_at>now()-interval '24 hours' or (status='processing' and lease_until>now())))
 or (select count(*) from public.content_agent_signals where user_id=p_user_id and id<>s.id and (delivered_at>now()-interval '7 days' or (status='processing' and lease_until>now())))>=3
 then
   update public.content_agent_signals set status='pending',next_attempt_at=now()+interval '1 hour',lease_key=null,lease_until=null where id=s.id;
   return null;
 end if;
 if nullif(btrim(p_payload->>'message'),'') is null or p_payload#>>'{proactive,signalId}' is distinct from s.id::text then raise exception 'Invalid proactive payload'; end if;
 -- Revalidate current canonical copy/status immediately before delivery. An edit forces a fresh read on retry.
 for binding in select value from jsonb_array_elements(coalesce(p_payload#>'{proactive,draftBindings}','[]'::jsonb)) order by value->>'socialPostId'
 loop
   perform 1 from public.social_posts where id=(binding->>'socialPostId')::uuid and user_id=p_user_id
     and status='draft' and body=binding->>'body' and coalesce(title,'')=binding->>'title' for update;
   if not found then raise exception 'Prepared draft changed'; end if;
 end loop;
 identity:=public.ensure_content_named_agent(p_user_id);
 insert into public.content_agent_messages(user_id,thread_id,role,content,payload,expires_at)
   values(p_user_id,(identity#>>'{thread,id}')::uuid,'assistant',p_payload->>'message',p_payload,now()+interval '180 days') returning id into mid;
 update public.content_agent_threads set last_message_at=now(),updated_at=now() where id=(identity#>>'{thread,id}')::uuid and user_id=p_user_id;
 update public.content_agent_signals set source_keys=array(select jsonb_array_elements_text(coalesce(p_payload#>'{proactive,sourceKeys}','[]'::jsonb))),topic_keys=array(select jsonb_array_elements_text(coalesce(p_payload#>'{proactive,topicKeys}','[]'::jsonb))),status='delivered',message_id=mid,delivered_at=now(),lease_key=null,lease_until=null where id=s.id;
 return mid;
end;
$$;

create function public.release_content_agent_signal(p_user_id uuid,p_signal_id uuid,p_lease_key uuid,p_status text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
 if p_status not in ('pending','failed','skipped') then raise exception 'Invalid signal status'; end if;
 perform 1 from public.profiles where id=p_user_id for update;
 update public.content_agent_signals set status=p_status,lease_key=null,lease_until=null,next_attempt_at=now()+interval '15 minutes'
 where id=p_signal_id and user_id=p_user_id and status='processing' and lease_key=p_lease_key and lease_until>now();
end;
$$;

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
revoke all on function public.queue_content_agent_scan() from public,anon,authenticated;
revoke all on function public.claim_content_agent_scans(integer) from public,anon,authenticated;
revoke all on function public.enqueue_content_agent_signal(uuid,text,text,text[],timestamptz) from public,anon,authenticated;
revoke all on function public.claim_due_content_agent_signals(integer) from public,anon,authenticated;
revoke all on function public.finish_content_agent_signal(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.release_content_agent_signal(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.feedback_content_agent_signal(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_content_agent_scans(integer),public.enqueue_content_agent_signal(uuid,text,text,text[],timestamptz),public.claim_due_content_agent_signals(integer),public.finish_content_agent_signal(uuid,uuid,uuid,jsonb),public.release_content_agent_signal(uuid,uuid,uuid,text),public.feedback_content_agent_signal(uuid,uuid,text) to service_role;
-- Canonical edits use the same workspace-first lock order and a snapshot guard.
create function public.edit_content_agent_draft(p_user_id uuid,p_message_id uuid,p_card_id text,p_body text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare saved jsonb; current_payload jsonb; card jsonb; binding jsonb; card_index int; binding_index int;
begin
 if length(btrim(p_body))<1 or length(p_body)>10000 then raise exception 'Invalid draft'; end if;
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then return false; end if;
 perform 1 from public.content_agent_signals where user_id=p_user_id and message_id=p_message_id for update;
 select payload into saved from public.content_agent_messages where id=p_message_id and user_id=p_user_id and role='assistant' and expires_at>now();
 if not found then return false; end if;
 select value,ordinality-1 into card,card_index from jsonb_array_elements(saved->'cards') with ordinality where value->>'cardId'=p_card_id and value->>'type'='draft';
 if card is null then return false; end if;
 select value,ordinality-1 into binding,binding_index from jsonb_array_elements(coalesce(saved#>'{proactive,draftBindings}','[]'::jsonb)) with ordinality where value->>'cardId'=p_card_id;
 if binding is not null then
   perform 1 from public.social_posts where id=(binding->>'socialPostId')::uuid and user_id=p_user_id
     and status='draft' and body=binding->>'body' and coalesce(title,'')=binding->>'title' for update;
   if not found then return false; end if;
 end if;
 select payload into current_payload from public.content_agent_messages where id=p_message_id and user_id=p_user_id for update;
 if current_payload is distinct from saved then return false; end if;
 if binding is not null then
   update public.social_posts set body=p_body,updated_at=now() where id=(binding->>'socialPostId')::uuid and user_id=p_user_id;
   saved:=jsonb_set(saved,array['proactive','draftBindings',binding_index::text,'body'],to_jsonb(p_body));
 end if;
 saved:=jsonb_set(saved,array['cards',card_index::text,'body'],to_jsonb(p_body));
 if card ? 'editorial' then saved:=jsonb_set(saved,array['cards',card_index::text,'editorial','validationState'],'"needs_review"'::jsonb); end if;
 update public.content_agent_messages set payload=saved where id=p_message_id and user_id=p_user_id;
 return true;
end;
$$;
revoke all on function public.edit_content_agent_draft(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.edit_content_agent_draft(uuid,uuid,text,text) to service_role;
commit;
