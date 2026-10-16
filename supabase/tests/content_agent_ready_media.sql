begin;
insert into public.profiles(id,username,plan_id,trial_ends_at) values
 ('90000000-0000-4000-8000-000000000001','ready_media_owner','creator_plus',now()+interval '1 day'),
 ('90000000-0000-4000-8000-000000000002','ready_media_other','creator_plus',now()+interval '1 day');
set local role service_role;
do $$
declare owner uuid:='90000000-0000-4000-8000-000000000001'; other uuid:='90000000-0000-4000-8000-000000000002';
 tid uuid; mid uuid; pid uuid; a uuid; b uuid; foreign_account uuid; plan jsonb; again jsonb; state jsonb; item jsonb; t timestamptz; i int; photo uuid;
begin
 tid:=(public.ensure_content_named_agent(owner)#>>'{thread,id}')::uuid;
 perform public.ensure_content_named_agent(other);
 insert into public.social_connections(user_id,provider,provider_user_id,provider_handle,access_token) values(owner,'linkedin','ready-media-a','ready-media-a','synthetic') returning id into a;
 insert into public.social_connections(user_id,provider,provider_user_id,provider_handle,access_token) values(owner,'linkedin','ready-media-b','ready-media-b','synthetic') returning id into b;
 insert into public.social_connections(user_id,provider,provider_user_id,provider_handle,access_token) values(other,'linkedin','ready-media-foreign','ready-media-foreign','synthetic') returning id into foreign_account;
 perform public.update_content_agent_preferences(owner,jsonb_build_object('destination_accounts',jsonb_build_object('linkedin',b)));
 begin
   perform public.update_content_agent_preferences(owner,jsonb_build_object('destination_accounts',jsonb_build_object('linkedin',foreign_account)));
   raise exception 'Expected foreign account rejection';
 exception when others then if sqlerrm='Expected foreign account rejection' then raise; end if; end;
 for i in 1..30 loop
   insert into public.content_agent_messages(user_id,thread_id,role,content,payload)
   values(owner,tid,'assistant','Synthetic draft',jsonb_build_object('cards',jsonb_build_array(jsonb_build_object('type','draft','cardId','x','platform','twitter','format','post','body','Synthetic copy')))) returning id into mid;
   plan:=public.reserve_content_agent_media_plan(owner,mid,'x');
   again:=public.reserve_content_agent_media_plan(owner,mid,'x');
   if plan->>'id'<>again->>'id' then raise exception 'Retry consumed an X slot'; end if;
 end loop;
 if (select count(*) from public.content_agent_media_plans where user_id=owner)<>30 or
    exists(select 1 from public.content_agent_media_plans where user_id=owner group by (ordinal-1)/10 having count(*) filter(where photo_required)<>7)
 then raise exception 'X photo allocation is not 70 percent'; end if;
 begin perform public.reserve_content_agent_media_plan(other,mid,'x'); raise exception 'Expected foreign draft rejection';
 exception when others then if sqlerrm='Expected foreign draft rejection' then raise; end if; end;
 insert into public.content_agent_messages(user_id,thread_id,role,content,payload)
 values(owner,tid,'assistant','Synthetic LinkedIn draft','{"cards":[{"type":"draft","cardId":"li","platform":"linkedin","format":"post","body":"A clear point.","title":""}]}') returning id into mid;
 plan:=public.reserve_content_agent_media_plan(owner,mid,'li');
 if plan->>'photo_required'<>'true' then raise exception 'LinkedIn photo optional'; end if;
 state:=public.mutate_content_agent_draft(owner,mid,'li',0,'prepare',jsonb_build_object('mediaIds','[]'::jsonb,'branding',plan->'branding','photoRequired',true,'preparation','photo_needed'));
 -- Incomplete drafts may open in the scheduler to upload a missing photo; publishing stays blocked.
 state:=public.mutate_content_agent_draft(owner,mid,'li',1,'handoff');
 if state->>'socialPostId' is null then raise exception 'Missing photo could not be repaired in scheduler'; end if;
 insert into public.creator_content_media(user_id,connection_id,post_id,asset_id,provider,media_type,status,storage_key,mime_type,byte_size)
 values(owner,a,'synthetic','synthetic','linkedin','image','ready','users/'||owner||'/photo.jpg','image/jpeg',42) returning id into photo;
 item:=jsonb_build_array(jsonb_build_object('key','users/'||owner||'/photo.jpg','mimeType','image/jpeg','size',42));
 state:=public.mutate_content_agent_draft(owner,mid,'li',1,'prepare',jsonb_build_object('mediaIds',jsonb_build_array(photo),'branding',plan->'branding','photoRequired',true,'preparation','ready'),item);
 state:=public.mutate_content_agent_draft(owner,mid,'li',2,'handoff','{}',item); pid:=(state->>'socialPostId')::uuid;
 if (select count(*) from public.social_post_targets where post_id=pid and connection_id=b and status='pending')<>1
   or (select status from public.social_posts where id=pid)<>'draft'
   or exists(select 1 from public.social_outbox_events e join public.social_post_targets t on t.id=e.target_id where t.post_id=pid)
 then raise exception 'Default destination missing or draft queued'; end if;
 if (public.reserve_content_agent_media_plan(owner,mid,'li')->>'id')<>(plan->>'id') then raise exception 'Handoff allocated another media slot'; end if;
 state:=public.mutate_content_agent_draft(owner,mid,'li',2,'edit','{"body":"A clearer point."}');
 if state->'mediaIds'<>jsonb_build_array(photo) then raise exception 'Copy edit discarded the reviewed photo'; end if;

 if (select updated_at from public.social_posts where id=pid) is distinct from (state->>'postUpdatedAt')::timestamptz then raise exception 'Target setup broke scheduler CAS'; end if;
 -- A creator's deselection is durable. Opening the draft cannot put it back.
 delete from public.social_post_targets where post_id=pid;
 perform public.prepare_content_agent_destinations(owner,pid);
 if exists(select 1 from public.social_post_targets where post_id=pid) then raise exception 'Manual deselection overwritten'; end if;
 -- An empty photo cannot bypass the requirement through the scheduler API.
 begin
   perform public.save_social_post_atomic(owner,pid,'A clearer point.','','[]',now()+interval '1 day','UTC',jsonb_build_array(jsonb_build_object('connectionId',b,'provider','linkedin','providerSettings','{}'::jsonb)),false);
   raise exception 'Expected scheduler photo rejection';
 exception when others then if sqlerrm<>'This agent post needs a photo before publishing.' then raise; end if; end;
 select updated_at into t from public.social_posts where id=pid;
 update public.social_posts set body='Creator edited the draft',updated_at=clock_timestamp() where id=pid;
 if public.prepare_content_agent_post(owner,pid,t,'{"revision":0,"preparation":"ready"}',item) then raise exception 'Stale preparation overwrote a creator edit'; end if;
 if (select body from public.social_posts where id=pid)<>'Creator edited the draft' then raise exception 'Copy changed'; end if;
 if has_function_privilege('authenticated','public.reserve_content_agent_media_plan(uuid,uuid,text,uuid)','execute')
   or has_table_privilege('authenticated','public.content_agent_media_plans','select') then raise exception 'Preparation data exposed'; end if;
end; $$;
rollback;
