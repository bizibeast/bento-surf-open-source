-- Brain keeps a small, intentional R2 library. Social Insights remains the
-- catalog of posts; importing every attachment is no longer an ingestion side effect.
create table public.creator_media_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);
create index creator_media_folders_user_idx on public.creator_media_folders(user_id, name);
alter table public.creator_media_folders enable row level security;
revoke all on public.creator_media_folders from public, anon, authenticated;
grant all on public.creator_media_folders to service_role;

create function public.enforce_creator_media_folder_limit() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if (select count(*) from public.creator_media_folders where user_id=new.user_id)>=20 then
    raise exception 'Media folder limit reached';
  end if;
  return new;
end; $$;
create trigger creator_media_folder_limit before insert on public.creator_media_folders
  for each row execute function public.enforce_creator_media_folder_limit();
revoke all on function public.enforce_creator_media_folder_limit() from public,anon,authenticated;

alter table public.creator_content_media alter column connection_id drop not null;
alter table public.creator_content_media drop constraint creator_content_media_status_check;
alter table public.creator_content_media add constraint creator_content_media_status_check
  check (status in ('catalog','pending','ready','unavailable'));
alter table public.creator_content_media add column import_origin text not null default 'catalog'
  check (import_origin in ('catalog','automatic','requested','upload','legacy'));
alter table public.creator_content_media add column auto_selected_at timestamptz;
alter table public.creator_content_media add column folder_id uuid;
alter table public.creator_content_media add constraint creator_media_folder_owner_fk
  foreign key (folder_id,user_id) references public.creator_media_folders(id,user_id) on delete set null (folder_id);
alter table public.creator_content_media add column hero_slot smallint
  check (hero_slot is null or (hero_slot between 1 and 4 and media_type in ('image','thumbnail') and status='ready'));
alter table public.creator_content_media add column lease_id uuid;
alter table public.creator_content_media add column lease_expires_at timestamptz;
create unique index creator_content_media_hero_slot_idx on public.creator_content_media(user_id,hero_slot)
  where hero_slot is not null;
create unique index creator_content_media_upload_key_idx on public.creator_content_media(user_id,storage_key)
  where provider='upload' and storage_key is not null;
create index creator_content_media_due_idx on public.creator_content_media(next_attempt_at)
  where status='pending' and import_origin in ('automatic','requested');

-- Preserve files already in R2, but stop the 959-item-style pending backlog.
update public.creator_content_media set import_origin='legacy' where status='ready';
update public.creator_content_media set status='catalog',import_origin='catalog',lease_id=null,lease_expires_at=null
  where status='pending';

create or replace function public.request_creator_content_index(p_user_id uuid,p_force boolean default false)
returns void language sql security definer set search_path=public as $$
  insert into creator_content_index_jobs(user_id,next_attempt_at)
  values(p_user_id,now()+interval '15 seconds')
  on conflict(user_id) do update set requested_at=now(),
    next_attempt_at=least(creator_content_index_jobs.next_attempt_at,now()+interval '15 seconds'),
    status=case when creator_content_index_jobs.lease_expires_at>now() then 'running' else 'pending' end,
    attempts=case when creator_content_index_jobs.lease_expires_at>now() then creator_content_index_jobs.attempts else 0 end,
    source_fingerprint=case when p_force then null else creator_content_index_jobs.source_fingerprint end,
    error_message=null;
$$;

create or replace function public.queue_creator_content_index() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' or old.caption is distinct from new.caption
    or old.media_sources is distinct from new.media_sources
    or old.content_type is distinct from new.content_type then
    perform request_creator_content_index(new.user_id,false);
  end if;
  return new;
end; $$;

-- One image/cover per winning post, up to ten assets per platform. Ranking is
-- internal to Postgres, so no entire attachment list is sent to the Worker.
create function public.refresh_creator_auto_media(p_user_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare selected_count integer; selection_mark timestamptz:=clock_timestamp();
begin
  with candidate as (
    select post.user_id,post.connection_id,post.provider,post.remote_post_id,post.remote_post_url,
      post.caption,post.published_at,coalesce(post.engagements,0) as engagements,
      asset.value->>'id' as asset_id,asset.value->>'type' as media_type,
      asset.value->>'url' as remote_url,
      row_number() over (partition by post.connection_id,post.remote_post_id
        order by case when asset.value->>'type'='image' then 0 else 1 end,asset.ordinality) as post_asset_rank
    from public.social_content_insights post
    cross join lateral jsonb_array_elements(post.media_sources) with ordinality asset(value,ordinality)
    where post.user_id=p_user_id and asset.value->>'type' in ('image','thumbnail')
      and nullif(asset.value->>'id','') is not null
      and (nullif(asset.value->>'url','') is not null or post.provider='linkedin')
  ), ranked as (
    select candidate.*, row_number() over (partition by provider
      order by engagements desc,published_at desc,connection_id,remote_post_id) as platform_rank
    from candidate where post_asset_rank=1
  ), chosen as (
    select * from ranked where platform_rank<=10
  ), saved as (
    insert into public.creator_content_media
      (user_id,connection_id,post_id,asset_id,provider,media_type,remote_url,source_url,caption,status,import_origin,auto_selected_at)
    select user_id,connection_id,remote_post_id,asset_id,provider,media_type,remote_url,
      remote_post_url,left(coalesce(caption,''),10000),'pending','automatic',selection_mark
    from chosen
    on conflict (connection_id,post_id,asset_id) do update set
      import_origin=case when creator_content_media.import_origin='requested' then 'requested' else 'automatic' end,
      auto_selected_at=selection_mark,
      caption=excluded.caption,remote_url=excluded.remote_url,source_url=excluded.source_url,
      status=case when creator_content_media.status='catalog' then 'pending' else creator_content_media.status end
    returning id
  ) select count(*) into selected_count from saved;

  update public.creator_content_media set import_origin='catalog',
    status=case when status='pending' then 'catalog' else status end,
    lease_id=null,lease_expires_at=null
  where user_id=p_user_id and import_origin='automatic'
    and auto_selected_at is distinct from selection_mark;
  return selected_count;
end; $$;
revoke all on function public.refresh_creator_auto_media(uuid) from public,anon,authenticated;
grant execute on function public.refresh_creator_auto_media(uuid) to service_role;

-- A lease prevents two queue deliveries from downloading the same asset.
create function public.claim_creator_media_imports(p_limit integer default 100)
returns table(id uuid,user_id uuid,lease_id uuid)
language sql security definer set search_path=public as $$
  with first_due as (
    select distinct on (candidate.user_id) candidate.id,candidate.user_id,candidate.next_attempt_at
    from public.creator_content_media candidate
    where candidate.status='pending' and candidate.import_origin in ('automatic','requested')
      and candidate.next_attempt_at<=now()
      and (candidate.lease_expires_at is null or candidate.lease_expires_at<=now())
      and not exists (
        select 1 from public.creator_content_media active
        where active.user_id=candidate.user_id and active.lease_expires_at>now()
      )
    order by candidate.user_id,candidate.next_attempt_at,candidate.created_at
  ), chosen as (
    select media.id from public.creator_content_media media
    join first_due on first_due.id=media.id
    order by first_due.next_attempt_at
    limit greatest(1,least(p_limit,100)) for update of media skip locked
  )
  update public.creator_content_media media set lease_id=gen_random_uuid(),
    lease_expires_at=now()+interval '10 minutes'
  where media.id in (select chosen.id from chosen)
  returning media.id,media.user_id,media.lease_id;
$$;
revoke all on function public.claim_creator_media_imports(integer) from public,anon,authenticated;
grant execute on function public.claim_creator_media_imports(integer) to service_role;

create function public.creator_brain_media_used_bytes(p_user_id uuid)
returns bigint language sql stable security definer set search_path=public as $$
  select coalesce(sum(asset.byte_size),0)::bigint from (
    select max(byte_size) as byte_size from public.creator_content_media
    where user_id=p_user_id and status='ready' and storage_key is not null
    group by storage_key
  ) asset;
$$;
revoke all on function public.creator_brain_media_used_bytes(uuid) from public,anon,authenticated;
grant execute on function public.creator_brain_media_used_bytes(uuid) to service_role;

create function public.request_creator_media_from_post(p_user_id uuid,p_post_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare source record; asset record; media_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select * into source from public.social_content_insights
    where id=p_post_id and user_id=p_user_id;
  if not found then raise exception 'Connected post not found'; end if;
  select value->>'id' as id,value->>'type' as media_type,value->>'url' as remote_url
    into asset from jsonb_array_elements(source.media_sources) with ordinality media(value,ordinality)
    where value->>'type' in ('image','thumbnail','video') and nullif(value->>'id','') is not null
      and (nullif(value->>'url','') is not null or source.provider='linkedin')
    order by case value->>'type' when 'image' then 0 when 'thumbnail' then 1 else 2 end,ordinality limit 1;
  if not found then raise exception 'This post has no importable media'; end if;
  select id into media_id from public.creator_content_media
    where connection_id=source.connection_id and post_id=source.remote_post_id and asset_id=asset.id;
  if media_id is null and (select count(*) from public.creator_content_media
    where user_id=p_user_id and import_origin in ('requested','upload'))>=50 then
    raise exception 'Media library limit reached';
  end if;
  insert into public.creator_content_media
    (user_id,connection_id,post_id,asset_id,provider,media_type,remote_url,source_url,caption,status,import_origin)
  values (p_user_id,source.connection_id,source.remote_post_id,asset.id,source.provider,asset.media_type,
    asset.remote_url,source.remote_post_url,left(coalesce(source.caption,''),10000),'pending','requested')
  on conflict (connection_id,post_id,asset_id) do update set
    import_origin='requested',
    status=case when creator_content_media.status in ('catalog','unavailable') then 'pending' else creator_content_media.status end,
    next_attempt_at=now(),lease_id=null,lease_expires_at=null
  returning id into media_id;
  return media_id;
end; $$;
revoke all on function public.request_creator_media_from_post(uuid,uuid) from public,anon,authenticated;
grant execute on function public.request_creator_media_from_post(uuid,uuid) to service_role;

create function public.register_creator_uploaded_media(p_user_id uuid,p_key text,p_url text,p_name text,p_mime text,p_bytes bigint)
returns uuid language plpgsql security definer set search_path=public as $$
declare media_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select id into media_id from public.creator_content_media where user_id=p_user_id and storage_key=p_key;
  if media_id is not null then return media_id; end if;
  if (select count(*) from public.creator_content_media
    where user_id=p_user_id and import_origin in ('requested','upload'))>=50 then
    raise exception 'Media library limit reached';
  end if;
  if public.creator_brain_media_used_bytes(p_user_id)+p_bytes>1073741824 then
    raise exception 'Brain Media storage limit reached';
  end if;
  insert into public.creator_content_media
    (user_id,post_id,asset_id,provider,media_type,caption,status,import_origin,storage_key,public_url,mime_type,byte_size)
  values (p_user_id,p_key,p_key,'upload',case when p_mime like 'video/%' then 'video' else 'image' end,
    left(p_name,10000),'ready','upload',p_key,p_url,p_mime,p_bytes)
  returning id into media_id;
  return media_id;
end; $$;
revoke all on function public.register_creator_uploaded_media(uuid,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.register_creator_uploaded_media(uuid,text,text,text,text,bigint) to service_role;

create function public.set_creator_hero_media(p_user_id uuid,p_media_id uuid,p_slot integer)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_slot not between 1 and 4 then raise exception 'Choose hero slot 1 to 4'; end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  update public.creator_content_media set hero_slot=null where user_id=p_user_id and hero_slot=p_slot;
  if p_media_id is not null then
    update public.creator_content_media set hero_slot=p_slot
      where id=p_media_id and user_id=p_user_id and status='ready' and media_type in ('image','thumbnail');
    if not found then raise exception 'Choose a ready image from your Media library'; end if;
  end if;
end; $$;
revoke all on function public.set_creator_hero_media(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.set_creator_hero_media(uuid,uuid,integer) to service_role;

-- Old uploads remain as Brain documents and are also available in Media.
insert into public.creator_content_media
  (user_id,post_id,asset_id,provider,media_type,caption,status,import_origin,storage_key,public_url,mime_type,byte_size)
select distinct on (user_id,source_ref)
  user_id,'brain-upload:'||id::text,id::text,'upload','image',title,'ready','legacy',source_ref,source_url,
  split_part(content,' ',1),coalesce(replace(substring(content from '([0-9][0-9,]*) bytes'),',','')::bigint,0)
from public.creator_brain_items
where kind='photo' and source_ref like 'users/'||user_id::text||'/%' and source_url is not null
order by user_id,source_ref,id;

-- Seed the bounded selection for existing profiles without fetching files during migration.
select public.refresh_creator_auto_media(user_id)
from (select distinct user_id from public.social_content_insights) existing_profiles;
