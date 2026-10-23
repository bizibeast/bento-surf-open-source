-- Persist rejection on the artifact so history pagination cannot resurrect its controls.
create or replace function public.reject_content_agent_draft(
  p_user_id uuid, p_message_id uuid, p_card_id text, p_reason text
) returns integer language plpgsql security invoker set search_path = '' as $$
declare
  m public.content_agent_messages;
  binding jsonb;
  cancelled_id uuid;
  binding_updated_at timestamptz;
begin
  if p_card_id is null or length(p_card_id) not between 1 and 120
     or p_reason is null or length(trim(p_reason)) not between 1 and 1000 then
    raise exception 'Invalid draft rejection';
  end if;
  -- Match feedback/edit locking: workspace -> signal -> thread -> message.
  -- Feedback locks the workspace before updating this message. Thread deletion
  -- locks the parent before cascading to messages, so acquire it first too.
  perform 1 from public.profiles where id=p_user_id for update;
  if not found then return -1; end if;
  perform 1 from public.content_agent_signals
    where user_id=p_user_id and message_id=p_message_id for update;
  perform 1 from public.content_agent_threads thread
    join public.content_agent_messages message
      on message.thread_id=thread.id and message.user_id=thread.user_id
    where thread.user_id=p_user_id and message.id=p_message_id
    for update of thread;
  if not found then return -1; end if;
  select * into m from public.content_agent_messages
    where id=p_message_id and user_id=p_user_id and role='assistant' and expires_at>now()
    for update;
  if not found or not exists (
    select 1 from jsonb_array_elements(coalesce(m.payload->'cards','[]'::jsonb)) c
    where c->>'type'='draft' and c->>'cardId'=p_card_id
  ) then return -1; end if;
  if coalesce(m.payload->'rejectedDraftIds','[]'::jsonb) ? p_card_id then return 0; end if;
  update public.content_agent_messages set payload=jsonb_set(payload,'{rejectedDraftIds}',
    coalesce(payload->'rejectedDraftIds','[]'::jsonb)||jsonb_build_array(p_card_id))
    where id=m.id and user_id=p_user_id;
  insert into public.content_agent_messages(user_id,thread_id,role,content,payload)
    values(p_user_id,m.thread_id,'system_event','Draft rejected.',jsonb_build_object('feedback',
      jsonb_build_object('type','rejected','messageId',m.id,'cardId',p_card_id,'reason',trim(p_reason))));

  -- Cancel only the unchanged routine draft represented by this exact artifact.
  -- Creator edits and scheduled/published copies remain independent work.
  for binding in select value from jsonb_array_elements(coalesce(m.payload#>'{proactive,draftBindings}','[]'::jsonb)) loop
    if binding->>'cardId'=p_card_id then
      -- Missing legacy snapshots cannot prove the Scheduler copy is unchanged.
      if nullif(binding->>'postUpdatedAt', '') is null then continue; end if;
      begin
        binding_updated_at := (binding->>'postUpdatedAt')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        continue;
      end;
      cancelled_id := null;
      update public.social_posts p set status='cancelled',cancelled_at=now(),updated_at=now()
        where p.user_id=p_user_id and p.id::text=binding->>'socialPostId'
          and p.status='draft' and p.updated_at=binding_updated_at
          and p.body=binding->>'body'
          and coalesce(p.title,'')=coalesce(binding->>'title','')
          and p.settings->>'routineRunId'=binding->>'runId'
        returning p.id into cancelled_id;
      if cancelled_id is not null then
        update public.social_post_targets set status='cancelled',next_attempt_at=null,lease_expires_at=null
          where post_id=cancelled_id and status in ('pending','queued','retrying');
      end if;
    end if;
  end loop;
  if jsonb_array_length(coalesce(m.payload->'cards','[]'::jsonb))=1 and m.payload ? 'proactive' then
    perform public.feedback_content_agent_signal(p_user_id,m.id,'not_relevant');
  end if;
  return 1;
end;
$$;
revoke all on function public.reject_content_agent_draft(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.reject_content_agent_draft(uuid,uuid,text,text) to service_role;


-- Enforce durable rejection under the mutation lock, including stale callers.
create or replace function public.mutate_content_agent_draft(
 p_user_id uuid,p_message_id uuid,p_card_id text,p_revision integer,p_operation text,
 p_patch jsonb default '{}'::jsonb,p_media jsonb default '[]'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare saved jsonb; current_payload jsonb; card jsonb; state jsonb; binding jsonb;
 card_index int; binding_index int; rev int; post_id uuid; post public.social_posts%rowtype;
 message_created timestamptz; next_card jsonb; ids jsonb; asset jsonb; media_id uuid;
 asset_key text; asset_mime text; asset_size bigint; i int; export_valid boolean;
begin
 if p_operation not in ('edit','attach','handoff','background','prepare') then raise exception 'Invalid operation'; end if;
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then raise exception 'Workspace unavailable'; end if;
 perform 1 from public.content_agent_signals where user_id=p_user_id and message_id=p_message_id for update;
 select payload,created_at into saved,message_created from public.content_agent_messages
 where id=p_message_id and user_id=p_user_id and role='assistant' and expires_at>now();
 if not found then raise exception 'Agent message expired or unavailable'; end if;
 if coalesce(saved->'rejectedDraftIds','[]'::jsonb) ? p_card_id then raise exception 'This draft was rejected'; end if;
 select value,ordinality-1 into card,card_index from jsonb_array_elements(saved->'cards') with ordinality where value->>'cardId'=p_card_id and value->>'type'='draft';
 if card is null then raise exception 'Draft unavailable'; end if;
 state:=coalesce(saved#>array['draftStates',p_card_id],'{"revision":0}'::jsonb);
 rev:=coalesce((state->>'revision')::int,0);
 if p_revision is null or rev<>p_revision then raise exception 'Draft changed. Reload and retry.'; end if;
 select value,ordinality-1 into binding,binding_index from jsonb_array_elements(coalesce(saved#>'{proactive,draftBindings}','[]'::jsonb)) with ordinality where value->>'cardId'=p_card_id;
 post_id:=coalesce((binding->>'socialPostId')::uuid,(state->>'socialPostId')::uuid);
 if post_id is not null then
   select * into post from public.social_posts where id=post_id and user_id=p_user_id for update;
   if not found or post.status<>'draft' or post.body is distinct from coalesce(binding->>'body',card->>'body')
     or coalesce(post.title,'') is distinct from coalesce(binding->>'title',card->>'title','')
     or (state ? 'postUpdatedAt' and post.updated_at is distinct from (state->>'postUpdatedAt')::timestamptz)
     or (not (state ? 'postUpdatedAt') and (post.updated_at>message_created or coalesce(jsonb_array_length(post.media),0)>0))
   then raise exception 'The scheduler draft changed. Open it in the scheduler to review your edits.'; end if;
 end if;
 select payload into current_payload from public.content_agent_messages where id=p_message_id and user_id=p_user_id and expires_at>now() for update;
 if not found or current_payload is distinct from saved then raise exception 'Draft changed. Reload and retry.'; end if;
 if coalesce(current_payload->'rejectedDraftIds','[]'::jsonb) ? p_card_id then raise exception 'This draft was rejected'; end if;
 next_card:=card;
 if p_operation='prepare' then
   ids:=coalesce(p_patch->'mediaIds','[]'::jsonb);
   rev:=rev+1;
   state:=state||jsonb_build_object('mediaIds',ids,'branding',p_patch->'branding','photoRequired',coalesce((p_patch->>'photoRequired')::boolean,false),
     'preparation',p_patch->>'preparation','preparationNote',coalesce(p_patch->>'preparationNote',''));
   if card->>'format'='carousel' and jsonb_array_length(ids)=jsonb_array_length(card->'slides') and jsonb_array_length(ids) between 2 and 10 then
     state:=state||jsonb_build_object('exportRevision',rev);
   else state:=state-'exportRevision'; end if;
 elsif p_operation='background' then
   ids:=p_patch->'mediaIds';
   if coalesce(jsonb_array_length(ids),0)<>1 then raise exception 'Choose one owned image'; end if;
   media_id:=(ids->>0)::uuid;
   select storage_key,mime_type,byte_size into asset_key,asset_mime,asset_size from public.content_agent_media where id=media_id and user_id=p_user_id;
   if not found then select storage_key,mime_type,byte_size into asset_key,asset_mime,asset_size from public.creator_content_media where id=media_id and user_id=p_user_id and status='ready'; end if;
   if asset_key is null or asset_key not like 'users/'||p_user_id::text||'/%' or asset_key is distinct from p_media->0->>'key' or asset_mime not in ('image/jpeg','image/png') or asset_size is distinct from (p_media->0->>'size')::bigint then raise exception 'Owned still image required'; end if;
   if card->>'format'='carousel' then
     i:=coalesce((p_patch->>'slideIndex')::int,0);
     if i<0 or i>=jsonb_array_length(card->'slides') then raise exception 'Slide unavailable'; end if;
     next_card:=jsonb_set(next_card,array['slides',i::text,'mediaId'],ids->0);
   else next_card:=jsonb_set(next_card,'{mediaIds}',ids); end if;
   state:=state-'exportRevision'-'mediaIds'; export_valid:=false;rev:=rev+1;
 elsif p_operation='edit' then
   if length(btrim(p_patch->>'body'))<1 or length(p_patch->>'body')>10000 or p_patch->>'body' is null then raise exception 'Invalid copy'; end if;
   next_card:=jsonb_set(card,'{body}',p_patch->'body');
   if p_patch ? 'slides' then
     if jsonb_array_length(p_patch->'slides')<2 or jsonb_array_length(p_patch->'slides')>10 then raise exception 'Use 2-10 slides'; end if;
     if exists(select 1 from jsonb_array_elements(p_patch->'slides') s where length(btrim(s->>'heading')) not between 1 and 90 or length(btrim(s->>'body')) not between 1 and 360 or s->>'body' is null or s->>'heading' is null) then raise exception 'Shorten slide copy before saving'; end if;
     next_card:=jsonb_set(next_card,'{slides}',p_patch->'slides');
   end if;
   export_valid:=card->>'platform'<>'instagram' or (state->>'exportRevision'=rev::text and card->'slides' is not distinct from next_card->'slides');
   rev:=rev+1;
   if card->>'platform'<>'instagram' then null;
   elsif export_valid then state:=state||jsonb_build_object('exportRevision',rev);
   else state:=state-'exportRevision'-'mediaIds'; end if;
   if next_card ? 'editorial' then next_card:=jsonb_set(next_card,'{editorial,validationState}','"needs_review"'); end if;
 elsif p_operation='attach' then
   ids:=p_patch->'mediaIds';
   if card->>'platform'<>'instagram' or card->>'format'<>'carousel' or jsonb_array_length(ids)<>jsonb_array_length(card->'slides') or coalesce(jsonb_array_length(ids),0) not between 2 and 10 then raise exception 'Export every carousel slide'; end if;
   rev:=rev+1;
   state:=state||jsonb_build_object('mediaIds',ids,'exportRevision',rev);
 end if;
 -- A historical/model slide ID is never proof of ownership, even during copy edits.
 if exists(select 1 from jsonb_array_elements(coalesce(next_card->'slides','[]')) s where s->>'mediaId' is not null and not exists(
 select 1 from public.content_agent_media m where m.id::text=s->>'mediaId' and m.user_id=p_user_id
 union all select 1 from public.creator_content_media m where m.id::text=s->>'mediaId' and m.user_id=p_user_id and m.status='ready')) then raise exception 'Background ownership changed'; end if;
 if p_operation in ('attach','handoff','prepare') then
   ids:=coalesce(state->'mediaIds',card->'mediaIds','[]'::jsonb);
   if p_operation<>'prepare' and card->>'platform'='instagram' and (card->>'format'<>'carousel' or state->>'exportRevision' is distinct from rev::text or coalesce(jsonb_array_length(ids),0)<2 or jsonb_array_length(ids) is distinct from jsonb_array_length(card->'slides')) then raise exception 'Copy ready, visuals needed. Export all slides first.'; end if;
   if jsonb_array_length(ids)<>jsonb_array_length(p_media) or (select count(distinct v) from jsonb_array_elements_text(ids) v)<>jsonb_array_length(ids) then raise exception 'Incomplete media'; end if;
   for i in 0..jsonb_array_length(ids)-1 loop
     media_id:=(ids->>i)::uuid;asset:=p_media->i;
     if (p_operation='attach' or (p_operation='prepare' and card->>'format'='carousel' and jsonb_array_length(ids)>0)) and not exists(select 1 from public.content_agent_media where id=media_id and user_id=p_user_id and source='carousel_export' and message_id=p_message_id and card_id=p_card_id and draft_revision=p_revision and slide_index=i) then raise exception 'Export each slide for the current draft revision'; end if;
     select storage_key,mime_type,byte_size into asset_key,asset_mime,asset_size from public.content_agent_media where id=media_id and user_id=p_user_id;
     if not found then select storage_key,mime_type,byte_size into asset_key,asset_mime,asset_size from public.creator_content_media where id=media_id and user_id=p_user_id and status='ready'; end if;
     if asset_key is null or asset_key not like 'users/'||p_user_id::text||'/%' or asset_key is distinct from asset->>'key' or asset_mime is distinct from asset->>'mimeType' or asset_size is distinct from (asset->>'size')::bigint then raise exception 'Media ownership or metadata changed'; end if;
     if card->>'platform'='instagram' and (asset_mime<>'image/jpeg' or asset_size>8388608 or asset_size<=0) then raise exception 'Instagram needs JPEG images under 8 MB'; end if;
   end loop;
 end if;
 state:=state||jsonb_build_object('revision',rev);
 if p_operation='handoff' and post_id is null then
   insert into public.social_posts(user_id,title,body,status,timezone,media,settings)
   values(p_user_id,nullif(card->>'title',''),card->>'body','draft','UTC',p_media,jsonb_build_object('platform',card->>'platform','agentMessageId',p_message_id,'agentCardId',p_card_id,'card',card,'agentDraftState',state)) returning * into post;
   post_id:=post.id;
 elsif post_id is not null and p_operation='handoff' and post.media is distinct from p_media then
   update public.social_posts set media=p_media,updated_at=clock_timestamp() where id=post_id and user_id=p_user_id returning * into post;
 elsif post_id is not null and p_operation in ('edit','attach','background','prepare') then
   update public.social_posts set body=next_card->>'body',
     media=case when p_operation in ('attach','prepare') or (p_operation='background' and card->>'platform'<>'instagram') then p_media when not coalesce(export_valid,true) and card->>'platform'='instagram' then '[]'::jsonb else media end,
     settings=settings||jsonb_build_object('card',next_card,'agentDraftState',state,'visualReadiness',case when state->>'exportRevision'=rev::text then 'ready' when card->>'platform'='instagram' then 'visuals_needed' else 'not_required' end),
     updated_at=clock_timestamp() where id=post_id and user_id=p_user_id returning * into post;
 end if;
 if post_id is not null then
   perform public.prepare_content_agent_destinations(p_user_id,post_id);
   select * into post from public.social_posts where id=post_id and user_id=p_user_id;
   state:=state||jsonb_build_object('socialPostId',post_id,'postUpdatedAt',post.updated_at);
   if binding is not null then
     saved:=jsonb_set(saved,array['proactive','draftBindings',binding_index::text,'body'],next_card->'body');
     saved:=jsonb_set(saved,array['proactive','draftBindings',binding_index::text,'postUpdatedAt'],to_jsonb(post.updated_at));
   end if;
 end if;
 saved:=jsonb_set(saved,array['cards',card_index::text],next_card);
 saved:=jsonb_set(saved,'{draftStates}',coalesce(saved->'draftStates','{}'::jsonb)||jsonb_build_object(p_card_id,state));
 update public.content_agent_messages set payload=saved where id=p_message_id and user_id=p_user_id;
 return state;
end; $$;

-- Image admission and queued-job claims serialize with rejection on the workspace.
create or replace function public.reserve_content_agent_image(p_user_id uuid,p_request_key text,p_count integer default 1,p_draft jsonb default '{}',p_prompt text default null,p_references uuid[] default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.content_agent_image_jobs%rowtype; quota jsonb; prefs public.content_agent_preferences%rowtype;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then raise exception 'Workspace unavailable'; end if;
 select * into job from public.content_agent_image_jobs where user_id=p_user_id and request_key=p_request_key;
 if found then return to_jsonb(job); end if;
 if (p_draft->>'messageId') is not null and not exists(select 1 from public.content_agent_messages where id=(p_draft->>'messageId')::uuid and user_id=p_user_id and role='assistant' and expires_at>now() and not (coalesce(payload->'rejectedDraftIds','[]'::jsonb) ? (p_draft->>'cardId'))) then raise exception 'Owned draft unavailable'; end if;
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
   if not coalesce(prefs.generate_images,false) or (job.request_source='agent' and ((cardinality(job.reference_ids)>0 and (not prefs.use_face_references or not job.reference_ids <@ prefs.reference_photo_ids)) or not exists(select 1 from public.content_agent_messages where id=job.message_id and user_id=p_user_id and role='assistant' and expires_at>now() and not (coalesce(payload->'rejectedDraftIds','[]'::jsonb) ? job.card_id))))
      or (job.request_source='scheduler' and cardinality(job.reference_ids)>0 and not job.references_confirmed) then
     update public.content_agent_image_jobs set status='failed',detail='Consent changed or draft expired before submission',updated_at=now() where id=p_id;
     return null;
   end if;
 end if;
 update public.content_agent_image_jobs set status=case when status='queued' then 'submitting' else status end, lease_key=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where id=p_id returning * into job;
 return to_jsonb(job);
end; $$;

revoke all on function public.mutate_content_agent_draft(uuid,uuid,text,integer,text,jsonb,jsonb), public.reserve_content_agent_image(uuid,text,integer,jsonb,text,uuid[]), public.claim_content_agent_image(uuid,uuid) from public,anon,authenticated;
grant execute on function public.mutate_content_agent_draft(uuid,uuid,text,integer,text,jsonb,jsonb), public.reserve_content_agent_image(uuid,text,integer,jsonb,text,uuid[]), public.claim_content_agent_image(uuid,uuid) to service_role;
