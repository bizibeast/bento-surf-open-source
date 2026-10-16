begin;
create table public.content_agent_media (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 storage_key text not null,
 mime_type text not null check (mime_type in ('image/jpeg','image/png')),
 byte_size bigint not null check (byte_size>0 and byte_size<=8388608),
 source text not null check (source in ('carousel_export','generated')),
 message_id uuid references public.content_agent_messages(id) on delete set null,
 card_id text not null,
 draft_revision integer not null check(draft_revision>=0),
 slide_index integer not null check(slide_index between 0 and 9),
 created_at timestamptz not null default now(),
 unique(user_id,storage_key),
 check (storage_key like 'users/' || user_id::text || '/%')
);
alter table public.content_agent_media enable row level security;
revoke all on public.content_agent_media from anon,authenticated;
grant all on public.content_agent_media to service_role;
-- Remove the unversioned mutation entry point: all new clients must supply a revision.
drop function public.edit_content_agent_draft(uuid,uuid,text,text);

-- Shared lock order: profile -> signals -> canonical post -> message. Media is read
-- under the profile lock; there is no network I/O in this transaction.
create function public.mutate_content_agent_draft(
 p_user_id uuid,p_message_id uuid,p_card_id text,p_revision integer,p_operation text,
 p_patch jsonb default '{}'::jsonb,p_media jsonb default '[]'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare saved jsonb; current_payload jsonb; card jsonb; state jsonb; binding jsonb;
 card_index int; binding_index int; rev int; post_id uuid; post public.social_posts%rowtype;
 message_created timestamptz; next_card jsonb; ids jsonb; asset jsonb; media_id uuid;
 asset_key text; asset_mime text; asset_size bigint; i int; export_valid boolean;
begin
 if p_operation not in ('edit','attach','handoff') then raise exception 'Invalid operation'; end if;
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
 if p_operation='edit' then
   if length(btrim(p_patch->>'body'))<1 or length(p_patch->>'body')>10000 or p_patch->>'body' is null then raise exception 'Invalid copy'; end if;
   next_card:=jsonb_set(card,'{body}',p_patch->'body');
   if p_patch ? 'slides' then
     if jsonb_array_length(p_patch->'slides')<2 or jsonb_array_length(p_patch->'slides')>10 then raise exception 'Use 2-10 slides'; end if;
     if exists(select 1 from jsonb_array_elements(p_patch->'slides') s where length(btrim(s->>'heading')) not between 1 and 90 or length(btrim(s->>'body')) not between 1 and 360 or s->>'body' is null or s->>'heading' is null) then raise exception 'Shorten slide copy before saving'; end if;
     next_card:=jsonb_set(next_card,'{slides}',p_patch->'slides');
   end if;
   export_valid:=state->>'exportRevision'=rev::text and card->'slides' is not distinct from next_card->'slides';
   rev:=rev+1;
   if export_valid then state:=state||jsonb_build_object('exportRevision',rev);
   else state:=state-'exportRevision'-'mediaIds'; end if;
   if next_card ? 'editorial' then next_card:=jsonb_set(next_card,'{editorial,validationState}','"needs_review"'); end if;
 elsif p_operation='attach' then
   ids:=p_patch->'mediaIds';
   if card->>'platform'<>'instagram' or card->>'format'<>'carousel' or jsonb_array_length(ids)<>jsonb_array_length(card->'slides') or coalesce(jsonb_array_length(ids),0) not between 2 and 10 then raise exception 'Export every carousel slide'; end if;
   rev:=rev+1;
   state:=state||jsonb_build_object('mediaIds',ids,'exportRevision',rev);
 end if;
 if p_operation in ('attach','handoff') then
   ids:=coalesce(state->'mediaIds',card->'mediaIds','[]'::jsonb);
   if card->>'platform'='instagram' and (card->>'format'<>'carousel' or state->>'exportRevision' is distinct from rev::text or coalesce(jsonb_array_length(ids),0)<2 or jsonb_array_length(ids) is distinct from jsonb_array_length(card->'slides')) then raise exception 'Copy ready, visuals needed. Export all slides first.'; end if;
   if jsonb_array_length(ids)<>jsonb_array_length(p_media) or (select count(distinct v) from jsonb_array_elements_text(ids) v)<>jsonb_array_length(ids) then raise exception 'Incomplete media'; end if;
   for i in 0..jsonb_array_length(ids)-1 loop
     media_id:=(ids->>i)::uuid;asset:=p_media->i;
     if p_operation='attach' and not exists(select 1 from public.content_agent_media where id=media_id and user_id=p_user_id and source='carousel_export' and message_id=p_message_id and card_id=p_card_id and draft_revision=p_revision and slide_index=i) then raise exception 'Export each slide for the current draft revision'; end if;
     select storage_key,mime_type,byte_size into asset_key,asset_mime,asset_size from public.content_agent_media where id=media_id and user_id=p_user_id;
     if not found then select storage_key,mime_type,byte_size into asset_key,asset_mime,asset_size from public.creator_content_media where id=media_id and user_id=p_user_id and status='ready'; end if;
     if asset_key is null or asset_key not like 'users/'||p_user_id::text||'/%' or asset_key is distinct from asset->>'key' or asset_mime is distinct from asset->>'mimeType' or asset_size is distinct from (asset->>'size')::bigint then raise exception 'Media ownership or metadata changed'; end if;
     if card->>'platform'='instagram' and (asset_mime<>'image/jpeg' or asset_size>8388608 or asset_size<=0) then raise exception 'Instagram needs JPEG images under 8 MB'; end if;
   end loop;
 end if;
 state:=state||jsonb_build_object('revision',rev);
 if p_operation='handoff' and post_id is null then
   insert into public.social_posts(user_id,title,body,status,timezone,media,settings)
   values(p_user_id,nullif(card->>'title',''),card->>'body','draft','UTC',p_media,jsonb_build_object('platform',card->>'platform','agentMessageId',p_message_id,'agentCardId',p_card_id)) returning * into post;
   post_id:=post.id;
 elsif post_id is not null and p_operation='handoff' and post.media is distinct from p_media then
   update public.social_posts set media=p_media,updated_at=clock_timestamp() where id=post_id and user_id=p_user_id returning * into post;
 elsif post_id is not null and p_operation in ('edit','attach') then
   update public.social_posts set body=next_card->>'body',
     media=case when p_operation='attach' then p_media when not coalesce(export_valid,true) and card->>'platform'='instagram' then '[]'::jsonb else media end,
     settings=settings||jsonb_build_object('card',next_card,'visualReadiness',case when state->>'exportRevision'=rev::text then 'ready' when card->>'platform'='instagram' then 'visuals_needed' else 'not_required' end),
     updated_at=clock_timestamp() where id=post_id and user_id=p_user_id returning * into post;
 end if;
 if post_id is not null then
   state:=state||jsonb_build_object('socialPostId',post_id,'postUpdatedAt',post.updated_at);
   if binding is not null then saved:=jsonb_set(saved,array['proactive','draftBindings',binding_index::text,'body'],next_card->'body'); end if;
 end if;
 saved:=jsonb_set(saved,array['cards',card_index::text],next_card);
 saved:=jsonb_set(saved,'{draftStates}',coalesce(saved->'draftStates','{}'::jsonb)||jsonb_build_object(p_card_id,state));
 update public.content_agent_messages set payload=saved where id=p_message_id and user_id=p_user_id;
 return state;
end; $$;
revoke all on function public.mutate_content_agent_draft(uuid,uuid,text,integer,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.mutate_content_agent_draft(uuid,uuid,text,integer,text,jsonb,jsonb) to service_role;
-- Provider/connection checks are performed by the existing scheduler service first.
-- This wrapper retains the draft locks through its atomic scheduling write.
create function public.save_agent_social_post_atomic(
 p_user_id uuid,p_post_id uuid,p_body text,p_title text,p_media jsonb,p_scheduled_at timestamptz,p_timezone text,p_targets jsonb,p_as_draft boolean,
 p_message_id uuid,p_card_id text,p_revision integer
) returns table(saved_post_id uuid,target_id uuid,idempotency_key uuid)
language plpgsql security invoker set search_path='' as $$
declare state jsonb; card jsonb;
begin
 state:=public.mutate_content_agent_draft(p_user_id,p_message_id,p_card_id,p_revision,'handoff','{}',p_media);
 select value into card from public.content_agent_messages m,jsonb_array_elements(m.payload->'cards') where m.id=p_message_id and m.user_id=p_user_id and value->>'cardId'=p_card_id;
 if card->>'body' is distinct from p_body or coalesce(card->>'title','') is distinct from coalesce(p_title,'') then raise exception 'Reviewed draft changed'; end if;
 return query select * from public.save_social_post_atomic(p_user_id,(state->>'socialPostId')::uuid,p_body,p_title,p_media,p_scheduled_at,p_timezone,p_targets,p_as_draft);
end; $$;
revoke all on function public.save_agent_social_post_atomic(uuid,uuid,text,text,jsonb,timestamptz,text,jsonb,boolean,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.save_agent_social_post_atomic(uuid,uuid,text,text,jsonb,timestamptz,text,jsonb,boolean,uuid,text,integer) to service_role;
commit;
