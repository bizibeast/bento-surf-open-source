-- Server cohort arguments default closed. Preference and source feedback are rechecked under the workspace lock.
-- Other Task 7 quota/media functions are deliberately preserved.

drop function public.claim_content_agent_scans(integer);
create function public.claim_content_agent_scans(p_limit integer default 3,p_workspace_ids uuid[] default '{}')
returns setof uuid language plpgsql security invoker set search_path = '' as $$
begin
 return query with due as (
   select user_id from public.content_agent_scan_queue where user_id=any(p_workspace_ids) and next_check_at <= now()
     order by next_check_at, user_id for update skip locked limit greatest(1,least(p_limit,10))
 ) update public.content_agent_scan_queue q set next_check_at = now()+interval '1 hour'
   from due where q.user_id=due.user_id returning q.user_id;
end;
$$;
revoke all on function public.claim_content_agent_scans(integer,uuid[]) from public,anon,authenticated;
grant execute on function public.claim_content_agent_scans(integer,uuid[]) to service_role;

drop function public.claim_due_content_agent_signals(integer);
create function public.claim_due_content_agent_signals(p_limit integer default 1,p_workspace_ids uuid[] default '{}')
returns setof public.content_agent_signals language plpgsql security invoker set search_path = '' as $$
declare ws uuid; s public.content_agent_signals; n integer := 0; paused boolean;
begin
 for ws in select p.id from public.profiles p join lateral (
   select min(next_attempt_at) due from public.content_agent_signals where user_id=p.id
     and status in ('pending','processing') and next_attempt_at<=now()
     and (lease_until is null or lease_until<=now())
 ) d on d.due is not null where p.id=any(p_workspace_ids) order by d.due,p.id for update of p skip locked limit greatest(1,least(p_limit,5))*10
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
revoke all on function public.claim_due_content_agent_signals(integer,uuid[]) from public,anon,authenticated;
grant execute on function public.claim_due_content_agent_signals(integer,uuid[]) to service_role;

drop function public.finish_content_agent_signal(uuid,uuid,uuid,jsonb);
create function public.finish_content_agent_signal(p_user_id uuid,p_signal_id uuid,p_lease_key uuid,p_payload jsonb,p_rollout_enabled boolean default false)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare s public.content_agent_signals; identity jsonb; mid uuid; binding jsonb; paused boolean; allowed_platforms text[];
begin
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then return null; end if;
 select proactive_paused,platforms into paused,allowed_platforms from public.content_agent_preferences where user_id=p_user_id for update;
 if exists(select 1 from public.profiles where id=p_user_id and workspace_status<>'active') then paused:=true; end if;
 select * into s from public.content_agent_signals where id=p_signal_id and user_id=p_user_id for update;
 if not found then return null; end if;
 if s.status='delivered' then return s.message_id; end if;
 if s.status<>'processing' or s.lease_key is distinct from p_lease_key or s.lease_until<=now() then return null; end if;
 -- Serialize current source feedback updates with delivery. Read again after any waiting writer commits.
 perform 1 from public.creator_content_recommendations r where r.user_id=p_user_id
   and (r.agent_source_key is null or r.agent_source_key=any(s.source_ids)
     or r.agent_source_key=any(array(select jsonb_array_elements_text(coalesce(p_payload#>'{proactive,sourceKeys}','[]'::jsonb)))))
   order by r.id for share;
 if not coalesce(p_rollout_enabled,false) or coalesce(paused,false)
 or coalesce(cardinality(allowed_platforms),0)=0
 or exists(select 1 from jsonb_array_elements(coalesce(p_payload->'cards','[]'::jsonb)) card
   where card->>'type'='draft' and not coalesce(card->>'platform'=any(allowed_platforms),false))
 or exists(select 1 from unnest(case when s.kind='fresh_source' then s.source_ids else array(select jsonb_array_elements_text(coalesce(p_payload#>'{proactive,sourceKeys}','[]'::jsonb))) end) source_key
   where not public.content_agent_source_available(p_user_id,source_key))
 or not public.bento_has_hosted_access(p_user_id) or s.observed_at<now()-interval '7 days'
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
revoke all on function public.finish_content_agent_signal(uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.finish_content_agent_signal(uuid,uuid,uuid,jsonb,boolean) to service_role;
