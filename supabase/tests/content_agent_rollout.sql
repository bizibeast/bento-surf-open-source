-- Real PostgreSQL integration; fixtures and changes roll back.
begin;
insert into public.profiles(id,username,plan_id,trial_ends_at) values
 ('80000000-0000-4000-8000-000000000001','agent_rollout_owner','creator_plus',now()+interval '1 day'),
 ('80000000-0000-4000-8000-000000000002','agent_rollout_second','creator_plus',now()+interval '1 day');
set local role service_role;
do $$
declare owner uuid:='80000000-0000-4000-8000-000000000001'; other uuid:='80000000-0000-4000-8000-000000000002';
 s public.content_agent_signals; sid uuid; mid uuid; rid uuid; runid uuid; postid uuid; recid uuid; p jsonb; i integer; gate_reason text;
begin
 perform public.ensure_content_named_agent(owner);perform public.ensure_content_named_agent(other);
 perform public.update_content_agent_preferences(owner,'{"platforms":["linkedin"]}');
 insert into public.creator_content_recommendations(user_id,fingerprint,kind,title,source_url,source_published_at)
 values(owner,'rollout-source','trend','Synthetic fixture','https://x.com/a/status/123',now()) returning id into recid;
 update public.creator_content_recommendations set agent_source_key='x:123' where id=recid;
 sid:=public.enqueue_content_agent_signal(owner,'fresh_source','race',array['x:123'],now());
 if exists(select 1 from public.claim_due_content_agent_signals(1)) then raise exception 'Default claim must be disabled';end if;
 if exists(select 1 from public.claim_content_agent_scans(1)) then raise exception 'Default scan must be disabled';end if;
 if exists(select 1 from public.claim_due_content_agent_signals(1,array[other])) then raise exception 'Cohort isolation failed';end if;
 -- Prepare first; change current preferences/source state before the atomic finish.
 foreach gate_reason in array array['platform','saved','not_relevant','unknown_saved','pause','rollout'] loop
   update public.content_agent_signals set next_attempt_at=now(),attempts=0 where id=sid;
   select * into strict s from public.claim_due_content_agent_signals(1,array[owner]);
   p:=jsonb_build_object('action','draft','message','Synthetic checked draft','cards',jsonb_build_array(jsonb_build_object('type','draft','cardId','draft','platform','linkedin','format','post','body','Synthetic copy')),'proactive',jsonb_build_object('signalId',sid,'sourceKeys',jsonb_build_array('x:123'),'topicKeys',jsonb_build_array('subject:testing useful drafts'),'draftBindings','[]'::jsonb));
   if gate_reason='platform' then perform public.update_content_agent_preferences(owner,'{"platforms":["instagram"]}');
   elsif gate_reason='pause' then perform public.update_content_agent_preferences(owner,'{"proactive_paused":true}');
   elsif gate_reason='unknown_saved' then update public.creator_content_recommendations set feedback='saved',agent_source_key=null where id=recid;
   elsif gate_reason in ('saved','not_relevant') then update public.creator_content_recommendations set feedback=gate_reason where id=recid;end if;
   if public.finish_content_agent_signal(owner,sid,s.lease_key,p,gate_reason<>'rollout') is not null then raise exception 'Final gate failed: %',gate_reason;end if;
   if exists(select 1 from public.content_agent_messages where user_id=owner) then raise exception 'Blocked finish created message';end if;
   perform public.update_content_agent_preferences(owner,'{"platforms":["linkedin"],"proactive_paused":false}');
   update public.creator_content_recommendations set feedback='pending',agent_source_key='x:123' where id=recid;
 end loop;
 -- Prepared routine -> durable queue and signal -> one named message -> feedback -> suppression.
 update public.content_agent_signals set status='skipped' where id=sid;
 insert into public.content_routines(user_id,template,platforms) values(owner,'fill_schedule',array['linkedin']) returning id into rid;
 insert into public.content_routine_runs(user_id,routine_id,scheduled_for) values(owner,rid,now()) returning id into runid;
 insert into public.social_posts(user_id,body,title,status) values(owner,'Prepared copy','Prepared title','draft') returning id into postid;
 update public.content_routine_runs set prepared_output=jsonb_build_object('version',1,'drafts',jsonb_build_array(jsonb_build_object('socialPostId',postid))) where id=runid;
 if not exists(select 1 from public.content_agent_scan_queue where user_id=owner) then raise exception 'Prepared output lost durable scan';end if;
 sid:=public.enqueue_content_agent_signal(owner,'prepared_routine','prepared',array[runid::text],now());
 select * into strict s from public.claim_due_content_agent_signals(1,array[owner]);
 p:=jsonb_set(p,'{proactive,signalId}',to_jsonb(sid));
 p:=jsonb_set(p,'{proactive,draftBindings}',jsonb_build_array(jsonb_build_object('cardId','draft','socialPostId',postid,'runId',runid,'title','Prepared title','body','Prepared copy')));
 if public.finish_content_agent_signal(other,sid,s.lease_key,p,true) is not null then raise exception 'Foreign finish';end if;
 if public.finish_content_agent_signal(owner,sid,s.lease_key,p) is not null then raise exception 'Default finish enabled';end if;
 update public.content_agent_signals set next_attempt_at=now(),attempts=0 where id=sid;
 select * into strict s from public.claim_due_content_agent_signals(1,array[owner]);
 mid:=public.finish_content_agent_signal(owner,sid,s.lease_key,p,true);
 if mid is null then raise exception 'Prepared delivery missing';end if;
 if public.finish_content_agent_signal(owner,sid,s.lease_key,p,true)<>mid then raise exception 'Retry not idempotent';end if;
 if (select count(*) from public.content_agent_messages where user_id=owner)<>1 then raise exception 'Duplicate message';end if;
 if not exists(select 1 from public.content_agent_messages m join public.content_agent_threads t on t.id=m.thread_id where m.id=mid and t.kind='agent' and m.role='assistant' and m.expires_at>now()+interval '179 days') then raise exception 'Identity/retention changed';end if;
 if (select status from public.social_posts where id=postid)<>'draft' then raise exception 'Delivery scheduled a post';end if;
 if not public.feedback_content_agent_signal(owner,mid,'not_relevant') then raise exception 'Feedback missing';end if;
 if public.feedback_content_agent_signal(other,mid,'not_relevant') then raise exception 'Foreign feedback accepted';end if;
 update public.content_agent_signals set delivered_at=now()-interval '25 hours' where id=sid;
 perform public.enqueue_content_agent_signal(owner,'fresh_source','future-same',array['x:123'],now());
 if exists(select 1 from public.claim_due_content_agent_signals(1,array[owner])) then raise exception 'Future rejected source delivered';end if;
end $$;
-- Second workspace carousel attachment/handoff and edits after export using final Task 7 mutation.
do $$
declare ws uuid:='80000000-0000-4000-8000-000000000002'; foreign_ws uuid:='80000000-0000-4000-8000-000000000001';
 tid uuid; mid uuid; ids uuid[]:='{}'; export_media jsonb:='[]'; asset uuid; state jsonb; postid uuid; i integer; key text;
begin
 select id into tid from public.content_agent_threads where user_id=ws and kind='agent';
 insert into public.content_agent_messages(user_id,thread_id,role,content,payload) values(ws,tid,'assistant','Carousel fixture','{"action":"draft","message":"Review","cards":[{"type":"draft","cardId":"carousel","platform":"instagram","format":"carousel","title":"Synthetic title","body":"Synthetic caption","slides":[{"heading":"Cover","body":"Point"},{"heading":"Takeaway","body":"Action"}]}]}') returning id into mid;
 for i in 0..1 loop
 key:='users/'||ws||'/rollout-'||i||'.jpg';
 insert into public.content_agent_media(user_id,storage_key,mime_type,byte_size,source,message_id,card_id,draft_revision,slide_index)
 values(ws,key,'image/jpeg',42,'carousel_export',mid,'carousel',0,i) returning id into asset;
 ids:=array_append(ids,asset);export_media:=export_media||jsonb_build_array(jsonb_build_object('key',key,'url','https://bento.surf/cdn/'||key,'mimeType','image/jpeg','size',42,'name','Slide'));
 end loop;
 begin perform public.mutate_content_agent_draft(foreign_ws,mid,'carousel',0,'attach',jsonb_build_object('mediaIds',ids),export_media);raise exception 'Foreign attachment accepted';exception when others then if sqlerrm='Foreign attachment accepted' then raise;end if;end;
 state:=public.mutate_content_agent_draft(ws,mid,'carousel',0,'attach',jsonb_build_object('mediaIds',ids),export_media);
 state:=public.mutate_content_agent_draft(ws,mid,'carousel',1,'handoff','{}',export_media);postid:=(state->>'socialPostId')::uuid;
 if not exists(select 1 from public.social_posts where id=postid and user_id=ws and status='draft' and social_posts.media=export_media) then raise exception 'Wrong handoff owner/status';end if;
 if public.mutate_content_agent_draft(ws,mid,'carousel',1,'handoff','{}',export_media)->>'socialPostId'<>postid::text then raise exception 'Handoff duplicated draft';end if;
 state:=public.mutate_content_agent_draft(ws,mid,'carousel',1,'edit','{"body":"Edited caption","slides":[{"heading":"New cover","body":"Changed"},{"heading":"Takeaway","body":"Action"}]}');
 if state?'exportRevision' then raise exception 'Stale export survived edit';end if;
 if exists(select 1 from public.social_posts where id=postid and jsonb_array_length(social_posts.media)>0) then raise exception 'Stale scheduler media survived';end if;
 begin perform public.mutate_content_agent_draft(ws,mid,'carousel',2,'handoff','{}',export_media);raise exception 'Stale handoff accepted';exception when others then if sqlerrm='Stale handoff accepted' then raise;end if;end;
end $$;
reset role;
do $$ begin
 if has_function_privilege('authenticated','public.finish_content_agent_signal(uuid,uuid,uuid,jsonb,boolean)','execute') then raise exception 'Browser controls rollout';end if;
end $$;
rollback;
