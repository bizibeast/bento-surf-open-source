begin;
alter table public.content_agent_preferences
 add column branding jsonb not null default '{"accentColor":"#31577f","backgroundColor":"#f7f4ed","textColor":"#17213a","coverStyle":"text","heroPhotoId":null}',
 add column destination_accounts jsonb not null default '{}';

-- Snapshots and X media slots are allocated once per logical draft, including retries.
create table public.content_agent_media_plans (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 request_key text not null,
 platform text not null check(platform in ('twitter','linkedin','instagram')),
 ordinal bigint not null,
 photo_required boolean not null,
 branding jsonb not null,
 media_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),
 unique(user_id,request_key), unique(user_id,platform,ordinal)
);
alter table public.content_agent_media_plans enable row level security;
revoke all on public.content_agent_media_plans from public,anon,authenticated;
grant all on public.content_agent_media_plans to service_role;

alter function public.update_content_agent_preferences(uuid,jsonb) rename to update_content_agent_preferences_images;
create function public.update_content_agent_preferences(p_user_id uuid,p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare b jsonb; pair record;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 perform public.update_content_agent_preferences_images(p_user_id,p_patch);
 if p_patch ? 'branding' then
   b:=p_patch->'branding';
   if jsonb_typeof(b)<>'object' or coalesce(b->>'accentColor','') !~ '^#[0-9A-Fa-f]{6}$'
     or coalesce(b->>'backgroundColor','') !~ '^#[0-9A-Fa-f]{6}$' or coalesce(b->>'textColor','') !~ '^#[0-9A-Fa-f]{6}$'
     or coalesce(b->>'coverStyle','') not in ('text','portrait') then raise exception 'Invalid brand colors'; end if;
   if b->>'heroPhotoId' is not null and not exists(select 1 from public.creator_content_media m where m.id=(b->>'heroPhotoId')::uuid
      and m.user_id=p_user_id and m.status='ready' and m.media_type='image' and m.mime_type in ('image/jpeg','image/png','image/webp')
      and m.storage_key like 'users/'||p_user_id::text||'/%') then raise exception 'Choose an available photo from your library'; end if;
   update public.content_agent_preferences set branding=b where user_id=p_user_id;
 end if;
 if p_patch ? 'destination_accounts' then
   if jsonb_typeof(p_patch->'destination_accounts')<>'object' then raise exception 'Invalid accounts'; end if;
   for pair in select * from jsonb_each_text(p_patch->'destination_accounts') loop
     if pair.key not in ('twitter','linkedin','instagram') or not exists(select 1 from public.social_connections c
       where c.id=pair.value::uuid and c.user_id=p_user_id and c.provider=pair.key and c.status='active' and not c.reauth_required)
       then raise exception 'Choose a connected publishing account'; end if;
   end loop;
   update public.content_agent_preferences set destination_accounts=p_patch->'destination_accounts' where user_id=p_user_id;
 end if;
 return public.ensure_content_named_agent(p_user_id);
end; $$;

create function public.reserve_content_agent_media_plan(p_user_id uuid,p_message_id uuid,p_card_id text,p_post_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare payload jsonb; card jsonb; post public.social_posts%rowtype; plan public.content_agent_media_plans%rowtype;
 plan_key text; v_platform text; n bigint; b jsonb;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 if not found then raise exception 'Workspace unavailable'; end if;
 if p_message_id is not null then
   select m.payload into payload from public.content_agent_messages m where m.id=p_message_id and m.user_id=p_user_id and m.role='assistant' and m.expires_at>now();
   if not found then raise exception 'Draft unavailable'; end if;
   select value into card from jsonb_array_elements(payload->'cards') where value->>'type'='draft' and value->>'cardId'=p_card_id;
   p_post_id:=coalesce((payload#>>array['draftStates',p_card_id,'socialPostId'])::uuid,
     (select (value->>'socialPostId')::uuid from jsonb_array_elements(coalesce(payload#>'{proactive,draftBindings}','[]')) where value->>'cardId'=p_card_id));
 end if;
 if p_post_id is not null then
   select * into post from public.social_posts where id=p_post_id and user_id=p_user_id and status='draft';
   if not found then raise exception 'Draft unavailable'; end if;
   card:=coalesce(card,post.settings->'card');
   plan_key:='post:'||p_post_id::text;
 else plan_key:='message:'||p_message_id::text||':'||p_card_id; end if;
 if card is null or card->>'type'<>'draft' or card->>'cardId' is distinct from p_card_id
    or card->>'platform' not in ('twitter','linkedin','instagram') then raise exception 'Unsupported draft'; end if;
 v_platform:=card->>'platform';
 select * into plan from public.content_agent_media_plans where user_id=p_user_id and request_key=plan_key;
 if found then return to_jsonb(plan); end if;
 -- A message draft keeps the same media slot after its scheduler handoff.
 if p_message_id is not null then
   select * into plan from public.content_agent_media_plans where user_id=p_user_id and request_key='message:'||p_message_id::text||':'||p_card_id;
   if found then return to_jsonb(plan); end if;
 end if;
 perform public.ensure_content_named_agent(p_user_id);
 select prefs.branding into b from public.content_agent_preferences prefs where prefs.user_id=p_user_id;
 select coalesce(max(mp.ordinal),0)+1 into n from public.content_agent_media_plans mp where mp.user_id=p_user_id and mp.platform=v_platform;
 insert into public.content_agent_media_plans(user_id,request_key,platform,ordinal,photo_required,branding)
 values(p_user_id,plan_key,v_platform,n,v_platform='linkedin' or (v_platform='twitter' and (n-1)%10 in (0,1,2,4,5,7,8)),b) returning * into plan;
 return to_jsonb(plan);
end; $$;

-- Select exactly one account for this platform. Never queue, replace manual selections, or
-- choose another account when an explicit default is disconnected.
create function public.prepare_content_agent_destinations(p_user_id uuid,p_post_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare post public.social_posts%rowtype; chosen uuid; preferred text; platform text;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 select * into post from public.social_posts where id=p_post_id and user_id=p_user_id for update;
 if not found or post.status<>'draft' or post.settings->>'agentDestinationsPrepared'='true' then return; end if;
 platform:=post.settings->>'platform';
 if platform not in ('twitter','linkedin','instagram') or not (post.settings ? 'card') then return; end if;
 if not exists(select 1 from public.social_post_targets where post_id=p_post_id) then
   select destination_accounts->>platform into preferred from public.content_agent_preferences where user_id=p_user_id;
   select c.id into chosen from public.social_connections c where c.user_id=p_user_id and c.provider=platform
     and c.status='active' and not c.reauth_required and (preferred is null or c.id::text=preferred)
     order by c.created_at desc,c.id limit 1;
   if chosen is null then return; end if;
   insert into public.social_post_targets(post_id,connection_id,provider,status) values(p_post_id,chosen,platform,'pending');
 end if;
 update public.social_posts set settings=settings||'{"agentDestinationsPrepared":true}',updated_at=clock_timestamp() where id=p_post_id;
end; $$;

create function public.prepare_content_agent_post(p_user_id uuid,p_post_id uuid,p_updated_at timestamptz,p_state jsonb,p_media jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare post public.social_posts%rowtype; asset jsonb;
begin
 perform 1 from public.profiles where id=p_user_id for update;
 select * into post from public.social_posts where id=p_post_id and user_id=p_user_id for update;
 if not found or post.status<>'draft' or post.updated_at is distinct from p_updated_at then return false; end if;
 if post.settings->'card'->>'body' is distinct from post.body or coalesce(post.settings->'card'->>'title','') is distinct from coalesce(post.title,'')
   then return false; end if;
 for asset in select value from jsonb_array_elements(p_media) loop
   if asset->>'key' not like 'users/'||p_user_id::text||'/%' or not exists(
     select 1 from public.creator_content_media m where m.user_id=p_user_id and m.status='ready' and m.storage_key=asset->>'key' and m.mime_type=asset->>'mimeType' and m.byte_size=(asset->>'size')::bigint
     union all select 1 from public.content_agent_media m where m.user_id=p_user_id and m.storage_key=asset->>'key' and m.mime_type=asset->>'mimeType' and m.byte_size=(asset->>'size')::bigint)
   then raise exception 'Owned media required'; end if;
 end loop;
 update public.social_posts set media=p_media,settings=settings||jsonb_build_object('agentDraftState',p_state,
   'visualReadiness',p_state->>'preparation'),updated_at=clock_timestamp() where id=p_post_id;
 perform public.prepare_content_agent_destinations(p_user_id,p_post_id);
 return true;
end; $$;
revoke all on function public.update_content_agent_preferences_images(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.update_content_agent_preferences_images(uuid,jsonb) to service_role;
revoke all on function public.update_content_agent_preferences(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.update_content_agent_preferences(uuid,jsonb) to service_role;
revoke all on function public.reserve_content_agent_media_plan(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.reserve_content_agent_media_plan(uuid,uuid,text,uuid) to service_role;
revoke all on function public.prepare_content_agent_destinations(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_content_agent_destinations(uuid,uuid) to service_role;
revoke all on function public.prepare_content_agent_post(uuid,uuid,timestamptz,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_content_agent_post(uuid,uuid,timestamptz,jsonb,jsonb) to service_role;
commit;
