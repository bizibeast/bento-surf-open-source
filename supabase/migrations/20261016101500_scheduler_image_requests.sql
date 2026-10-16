begin;
-- Composer requests share the existing atomic image quota and submission leases.
alter table public.content_agent_image_jobs
 add column request_source text not null default 'agent' check(request_source in ('agent','scheduler')),
 add column references_confirmed boolean not null default false;
alter table public.content_agent_media drop constraint content_agent_media_source_check;
alter table public.content_agent_media add constraint content_agent_media_source_check check(source in ('carousel_export','generated','uploaded','stock'));
alter table public.content_agent_media drop constraint content_agent_media_mime_type_check;
alter table public.content_agent_media add constraint content_agent_media_mime_type_check check(mime_type in ('image/jpeg','image/png','image/webp'));
create or replace function public.reserve_content_agent_image(p_user_id uuid,p_request_key text,p_count integer default 1,p_draft jsonb default '{}',p_prompt text default null,p_references uuid[] default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.content_agent_image_jobs%rowtype; quota jsonb; prefs public.content_agent_preferences%rowtype;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then raise exception 'Workspace unavailable'; end if;
 select * into job from public.content_agent_image_jobs where user_id=p_user_id and request_key=p_request_key;
 if found then return to_jsonb(job); end if;
 if (p_draft->>'messageId') is not null and not exists(select 1 from public.content_agent_messages where id=(p_draft->>'messageId')::uuid and user_id=p_user_id and role='assistant' and expires_at>now()) then raise exception 'Owned draft unavailable'; end if;
 if p_count<>1 then raise exception 'Each image requires one durable job'; end if;
 if cardinality(p_references)>4 then raise exception 'Choose at most four reference images'; end if;
 select * into prefs from public.content_agent_preferences where user_id=p_user_id;
 if not coalesce(prefs.generate_images,false) then raise exception 'Enable AI images in Agent settings'; end if;
 if coalesce(p_draft->>'source','agent') not in ('agent','scheduler') then raise exception 'Invalid image source'; end if;
 if p_draft->>'source'='scheduler' and cardinality(p_references)>0 and (not coalesce((p_draft->>'referencesConfirmed')::boolean,false) or exists(select 1 from unnest(p_references) ref where not exists(select 1 from public.content_agent_media m where m.id=ref and m.user_id=p_user_id))) then raise exception 'Confirm owned reference images'; end if;
 if coalesce(p_draft->>'source','agent')='agent' and cardinality(p_references)>0 and (not prefs.use_face_references or not p_references <@ prefs.reference_photo_ids) then raise exception 'Review and enable reference photos first'; end if;
 quota:=public.content_agent_image_quota(p_user_id);
 if (quota->>'successful')::int+(quota->>'pending')::int>=100 then raise exception 'Monthly image limit reached, including pending images'; end if;
 if (select count(*) from public.content_agent_image_jobs where user_id=p_user_id and created_at>now()-interval '1 minute')>=5 then raise exception 'Please wait a minute before generating more images'; end if;
 insert into public.content_agent_image_jobs(user_id,request_key,message_id,card_id,draft_revision,target_slide_index,prompt,reference_ids,request_source,references_confirmed)
 values(p_user_id,p_request_key,(p_draft->>'messageId')::uuid,p_draft->>'cardId',(p_draft->>'revision')::int,coalesce((p_draft->>'slideIndex')::int,0),p_prompt,p_references,coalesce(p_draft->>'source','agent'),coalesce((p_draft->>'referencesConfirmed')::boolean,false)) returning * into job;
 return to_jsonb(job);
end; $$;
create or replace function public.claim_content_agent_image(p_user_id uuid,p_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.content_agent_image_jobs%rowtype; prefs public.content_agent_preferences%rowtype;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 select * into job from public.content_agent_image_jobs where id=p_id and user_id=p_user_id for update;
 if not found or job.status in ('ready','failed','ambiguous') or job.lease_until>now() then return null; end if;
 if job.status='submitting' then
   update public.content_agent_image_jobs set status='ambiguous',detail='Submission outcome unknown. Operator reconciliation required; no automatic retry.',updated_at=now() where id=p_id;
   return null;
 end if;
 if job.status='queued' then
   select * into prefs from public.content_agent_preferences where user_id=p_user_id;
   if not coalesce(prefs.generate_images,false) or (job.request_source='agent' and ((cardinality(job.reference_ids)>0 and (not prefs.use_face_references or not job.reference_ids <@ prefs.reference_photo_ids)) or not exists(select 1 from public.content_agent_messages where id=job.message_id and user_id=p_user_id and role='assistant' and expires_at>now())))
      or (job.request_source='scheduler' and cardinality(job.reference_ids)>0 and not job.references_confirmed) then
     update public.content_agent_image_jobs set status='failed',detail='Consent changed or draft expired before submission',updated_at=now() where id=p_id;
     return null;
   end if;
 end if;
 update public.content_agent_image_jobs set status=case when status='queued' then 'submitting' else status end, lease_key=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where id=p_id returning * into job;
 return to_jsonb(job);
end; $$;

commit;
