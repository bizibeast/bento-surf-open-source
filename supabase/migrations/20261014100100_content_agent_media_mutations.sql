begin;
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
   if binding is not null then saved:=jsonb_set(saved,array['proactive','draftBindings',binding_index::text,'body'],next_card->'body'); end if;
 end if;
 saved:=jsonb_set(saved,array['cards',card_index::text],next_card);
 saved:=jsonb_set(saved,'{draftStates}',coalesce(saved->'draftStates','{}'::jsonb)||jsonb_build_object(p_card_id,state));
 update public.content_agent_messages set payload=saved where id=p_message_id and user_id=p_user_id;
 return state;
end; $$;

commit;
