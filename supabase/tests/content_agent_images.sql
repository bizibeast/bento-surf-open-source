-- Run after Task 7 migration. All single-session fixtures roll back.
begin;
insert into public.profiles(id,username) values ('70000000-0000-4000-8000-000000000001','image_contract_owner'),('70000000-0000-4000-8000-000000000002','image_contract_other');
set local role service_role;
do $$
declare owner uuid:='70000000-0000-4000-8000-000000000001'; other uuid:='70000000-0000-4000-8000-000000000002'; identity jsonb; job jsonb; again jsonb; q jsonb; tid uuid; mid uuid; media uuid; state jsonb; connection uuid; photo uuid;
begin
 identity:=public.ensure_content_named_agent(owner);tid:=(identity#>>'{thread,id}')::uuid;
 if identity#>>'{preferences,generate_images}'<>'false' or identity#>>'{preferences,use_face_references}'<>'false' then raise exception 'Must default off'; end if;
 begin perform public.reserve_content_agent_image(owner,'off',1);raise exception 'Expected opt-in rejection';exception when others then if sqlerrm='Expected opt-in rejection' then raise; end if;end;
 perform public.update_content_agent_preferences(owner,'{"generate_images":true}');
 begin perform public.update_content_agent_preferences(owner,jsonb_build_object('reference_photo_ids',jsonb_build_array(other),'references_confirmed',true));raise exception 'Expected foreign reference rejection';exception when others then if sqlerrm='Expected foreign reference rejection' then raise; end if;end;
 insert into public.social_connections(user_id,provider,provider_user_id,provider_handle,access_token) values(owner,'instagram','image-test','image-test','synthetic-test-token') returning id into connection;
 insert into public.creator_content_media(user_id,connection_id,post_id,asset_id,provider,media_type,status,storage_key,mime_type,byte_size) values(owner,connection,'test','test','instagram','thumbnail','ready','users/'||owner||'/reference.jpg','image/jpeg',42) returning id into photo;
 begin perform public.update_content_agent_preferences(owner,jsonb_build_object('reference_photo_ids',jsonb_build_array(photo),'references_confirmed',true));raise exception 'Expected video cover rejection';exception when others then if sqlerrm='Expected video cover rejection' then raise;end if;end;
 update public.creator_content_media set media_type='image' where id=photo;
 begin perform public.update_content_agent_preferences(owner,jsonb_build_object('reference_photo_ids',jsonb_build_array(photo),'references_confirmed',false));raise exception 'Expected creator confirmation';exception when others then if sqlerrm='Expected creator confirmation' then raise;end if;end;
 perform public.update_content_agent_preferences(owner,jsonb_build_object('reference_photo_ids',jsonb_build_array(photo),'references_confirmed',true));
 insert into public.content_agent_messages(user_id,thread_id,role,content,payload) values(owner,tid,'assistant','Images', '{"action":"draft","message":"Draft","cards":[{"type":"draft","cardId":"draft","platform":"instagram","format":"carousel","title":"Title","body":"Caption","slides":[{"heading":"A point","body":"Detail"},{"heading":"Try it","body":"Next step"}]}]}') returning id into mid;
 job:=public.reserve_content_agent_image(owner,'first',1,jsonb_build_object('messageId',mid,'cardId','draft','revision',0),'A tree');
 again:=public.reserve_content_agent_image(owner,'first',1);if job->>'id'<>again->>'id' then raise exception 'Retry not idempotent';end if;
 perform public.update_content_agent_preferences(owner,'{"generate_images":false}');
 if public.claim_content_agent_image(owner,(job->>'id')::uuid) is not null then raise exception 'Revoked queued job submitted';end if;
 if (public.content_agent_image_quota(owner)->>'pending')::int<>0 then raise exception 'Cancelled reservation retained';end if;
 perform public.update_content_agent_preferences(owner,'{"generate_images":true}');
 -- Revoking with echoed saved IDs/removals must survive a deleted or unavailable photo.
 update public.content_agent_preferences set reference_photo_ids=array[other],use_face_references=true where user_id=owner;
 perform public.update_content_agent_preferences(owner,jsonb_build_object('generate_images',false,'use_face_references',false,'reference_photo_ids',jsonb_build_array(other),'references_confirmed',false));
 if exists(select 1 from public.content_agent_preferences where user_id=owner and (generate_images or use_face_references)) then raise exception 'Unavailable photo blocked revocation';end if;
 perform public.update_content_agent_preferences(owner,'{"generate_images":true,"reference_photo_ids":[]}');
 -- 99 successful current outputs, plus last month's pending request, fills all capacity.
 insert into public.content_agent_image_jobs(user_id,request_key,status,task_id,completed_at,output_count,created_at)
 select owner,'success-'||n,'ready','task-'||n,now(),1,now()-interval '2 minutes' from generate_series(1,99)n;
 insert into public.content_agent_image_jobs(user_id,request_key,message_id,status,task_id,created_at)
 values(owner,'previous-month',mid,'submitted','prior-task',date_trunc('month',now())-interval '1 day') returning to_jsonb(content_agent_image_jobs.*) into job;
 begin perform public.reserve_content_agent_image(owner,'overflow',1);raise exception 'Expected quota rejection';exception when others then if sqlerrm='Expected quota rejection' then raise;end if;end;
 -- Delete chat message: accepted task must remain counted and reconcilable.
 delete from public.content_agent_messages where id=mid;
 if (public.content_agent_image_quota(owner)->>'pending')::int<>1 then raise exception 'Message deletion released accepted quota';end if;
 again:=public.complete_content_agent_image(owner,(job->>'id')::uuid,now(),'["https://upload.apimart.ai/one.png"]',1);
 if again->>'message_id' is not null then raise exception 'Draft provenance did not SET NULL';end if;
 if again->>'status'<>'storage_pending' then raise exception 'Success not pending storage';end if;
 q:=public.content_agent_image_quota(owner);if (q->>'successful')::int<>100 or (q->>'pending')::int<>0 then raise exception 'Completion month accounting wrong: %',q;end if;
 perform public.complete_content_agent_image(owner,(job->>'id')::uuid,now(),'[]',2);
 if (public.content_agent_image_quota(owner)->>'successful')::int<>100 then raise exception 'Storage retry charged twice';end if;
 begin perform public.reserve_content_agent_image(owner,'after-storage-failure',1);raise exception 'Expected paid success quota rejection';exception when others then if sqlerrm='Expected paid success quota rejection' then raise;end if;end;
 -- Independent workspace quota, failure release, expired submitting lease remains ambiguous.
 perform public.ensure_content_named_agent(other);perform public.update_content_agent_preferences(other,'{"generate_images":true}');
 job:=public.reserve_content_agent_image(other,'ambiguous',1);
 update public.content_agent_image_jobs set status='submitting',lease_until=now()-interval '1 second' where id=(job->>'id')::uuid;
 perform public.claim_content_agent_image(other,(job->>'id')::uuid);
 if (select status from public.content_agent_image_jobs where id=(job->>'id')::uuid)<>'ambiguous' then raise exception 'Ambiguous request resubmitted';end if;
 if (public.content_agent_image_quota(other)->>'pending')::int<>1 then raise exception 'Ambiguous quota released';end if;
 update public.content_agent_image_jobs set status='failed' where id=(job->>'id')::uuid;
 if (public.content_agent_image_quota(other)->>'pending')::int<>0 then raise exception 'Confirmed failure not released';end if;
 -- Background CAS, complete exports invalidation, ownership, scheduler guard.
 insert into public.content_agent_messages(user_id,thread_id,role,content,payload) values(owner,tid,'assistant','Images', '{"cards":[{"type":"draft","cardId":"draft","platform":"instagram","format":"carousel","body":"Caption","slides":[{"heading":"A point","body":"Detail"},{"heading":"Try it","body":"Next step"}]}],"draftStates":{"draft":{"revision":1,"exportRevision":1,"mediaIds":[]}},"proactive":{"sourceKeys":["retain"],"topicKeys":["subject:one two"]}}') returning id into mid;
 insert into public.content_agent_media(user_id,storage_key,mime_type,byte_size,source,message_id,card_id,draft_revision,slide_index) values(owner,'users/'||owner||'/test.jpg','image/jpeg',42,'generated',mid,'draft',1,0) returning id into media;
 state:=public.mutate_content_agent_draft(owner,mid,'draft',1,'background',jsonb_build_object('mediaIds',jsonb_build_array(media),'slideIndex',1),jsonb_build_array(jsonb_build_object('key','users/'||owner||'/test.jpg','size',42)));
 if state->>'revision'<>'2' or state?'exportRevision' or state?'mediaIds' then raise exception 'Background did not invalidate exports';end if;
 if (select payload#>>'{cards,0,slides,1,mediaId}' from public.content_agent_messages where id=mid)<>media::text then raise exception 'Background not stored';end if;
 if (select payload#>>'{proactive,sourceKeys,0}' from public.content_agent_messages where id=mid)<>'retain' then raise exception 'Metadata overwritten';end if;
 begin perform public.mutate_content_agent_draft(owner,mid,'draft',1,'background',jsonb_build_object('mediaIds',jsonb_build_array(media)), '[]');raise exception 'Expected CAS failure';exception when others then if sqlerrm='Expected CAS failure' then raise;end if;end;
 begin perform public.mutate_content_agent_draft(owner,mid,'draft',2,'handoff');raise exception 'Expected incomplete export failure';exception when others then if sqlerrm='Expected incomplete export failure' then raise;end if;end;
 begin perform public.mutate_content_agent_draft(owner,mid,'draft',2,'edit',jsonb_build_object('body','Caption','slides',jsonb_build_array(jsonb_build_object('heading','A','body','B','mediaId',other),jsonb_build_object('heading','C','body','D'))));raise exception 'Expected background ownership failure';exception when others then if sqlerrm='Expected background ownership failure' then raise;end if;end;
end $$;
reset role;
do $$begin
 if has_function_privilege('authenticated','public.reserve_content_agent_image(uuid,text,integer,jsonb,text,uuid[])','execute') or has_table_privilege('authenticated','public.content_agent_image_jobs','select') then raise exception 'Browser ledger access exposed';end if;
end $$;
rollback;
