-- Social Insights owns ingestion. Durable jobs coalesce all provider pages for one creator.
alter table public.social_content_insights add column media_sources jsonb not null default '[]'::jsonb
  check (jsonb_typeof(media_sources)='array' and jsonb_array_length(media_sources)<=20);

create table public.creator_content_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  post_id text not null,
  asset_id text not null check(length(asset_id) between 1 and 500),
  provider text not null,
  media_type text not null check(media_type in ('image','video','thumbnail')),
  remote_url text,
  source_url text,
  caption text not null default '' check(length(caption)<=10000),
  tags text[] not null default '{}' check(cardinality(tags)<=8),
  status text not null default 'pending' check(status in ('pending','ready','unavailable')),
  storage_key text,
  public_url text,
  mime_type text,
  byte_size bigint not null default 0 check(byte_size>=0),
  error_message text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id,post_id,asset_id)
);
create function public.creator_media_search_document(p_caption text,p_tags text[])
returns tsvector language sql immutable set search_path=pg_catalog as $$
  select to_tsvector('simple',coalesce(p_caption,'')||' '||coalesce(array_to_string(p_tags,' '),''));
$$;
alter table public.creator_content_media add column search_document tsvector
  generated always as (public.creator_media_search_document(caption,tags)) stored;
create index creator_content_media_search_idx on public.creator_content_media using gin(search_document);

create index creator_content_media_owner_status_idx on public.creator_content_media(user_id,status);
alter table public.creator_content_media enable row level security;
revoke all on public.creator_content_media from public,anon,authenticated;
grant all on public.creator_content_media to service_role;

create table public.creator_content_index_jobs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  indexed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  status text not null default 'pending' check(status in ('pending','running','ready','error')),
  attempts integer not null default 0,
  source_fingerprint text,
  source_count integer not null default 0,
  media_count integer not null default 0,
  error_message text
);
alter table public.creator_content_index_jobs enable row level security;
revoke all on public.creator_content_index_jobs from public,anon,authenticated;
grant all on public.creator_content_index_jobs to service_role;

create function public.apply_creator_media_topics(p_user_id uuid,p_topics jsonb)
returns void language sql security definer set search_path=public as $$
  update creator_content_media media set tags=topics.tags
  from jsonb_to_recordset(p_topics) as topics(id uuid,tags text[])
  where media.user_id=p_user_id and media.id=topics.id;
$$;
revoke all on function public.apply_creator_media_topics(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.apply_creator_media_topics(uuid,jsonb) to service_role;

create function public.request_creator_content_index(p_user_id uuid,p_force boolean default false)
returns void language sql security definer set search_path=public as $$
  update creator_content_media set status='pending',attempts=0,next_attempt_at=now() where p_force and user_id=p_user_id and status='unavailable';
  insert into creator_content_index_jobs(user_id,next_attempt_at)
  values(p_user_id,now()+interval '15 seconds')
  on conflict(user_id) do update set requested_at=now(),
    next_attempt_at=least(creator_content_index_jobs.next_attempt_at,now()+interval '15 seconds'),
    status=case when creator_content_index_jobs.lease_expires_at>now() then 'running' else 'pending' end,
    attempts=case when creator_content_index_jobs.lease_expires_at>now() then creator_content_index_jobs.attempts else 0 end,
    source_fingerprint=case when p_force then null else creator_content_index_jobs.source_fingerprint end,
    error_message=null;
$$;
revoke all on function public.request_creator_content_index(uuid,boolean) from public,anon,authenticated;
grant execute on function public.request_creator_content_index(uuid,boolean) to service_role;

create function public.queue_creator_content_index() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' or old.caption is distinct from new.caption
    or old.media_sources is distinct from new.media_sources or old.content_type is distinct from new.content_type or old.fetched_at is distinct from new.fetched_at then
    insert into creator_content_media(user_id,connection_id,post_id,asset_id,provider,media_type,remote_url,source_url,caption)
      select new.user_id,new.connection_id,new.remote_post_id,asset.id,new.provider,asset.type,asset.url,new.remote_post_url,left(coalesce(new.caption,''),10000)
      from jsonb_to_recordset(new.media_sources) as asset(id text,type text,url text)
      where asset.id is not null and asset.type in ('image','video','thumbnail')
      on conflict(connection_id,post_id,asset_id) do update set caption=excluded.caption,source_url=excluded.source_url,remote_url=excluded.remote_url,
        status=case when creator_content_media.status='ready' then 'ready' when creator_content_media.status='unavailable' or creator_content_media.remote_url is distinct from excluded.remote_url then 'pending' else creator_content_media.status end,
        updated_at=now();
    perform request_creator_content_index(new.user_id,false);
  end if;
  return new;
end; $$;
revoke all on function public.queue_creator_content_index() from public,anon,authenticated;
create trigger social_posts_queue_content_index after insert or update of caption,media_sources,content_type,fetched_at
  on public.social_content_insights for each row execute function public.queue_creator_content_index();

create function public.claim_creator_content_indexes(p_limit integer default 3)
returns setof public.creator_content_index_jobs language sql security definer set search_path=public as $$
  update creator_content_index_jobs jobs set status='running',lease_id=gen_random_uuid(),
    lease_expires_at=now()+interval '10 minutes',attempts=attempts+1
  where user_id in (
    select candidate.user_id from creator_content_index_jobs candidate
    where candidate.status in ('pending','running','error') and candidate.next_attempt_at<=now()
      and (candidate.lease_expires_at is null or candidate.lease_expires_at<=now())
      and not exists(select 1 from social_analytics_snapshots snapshots where snapshots.user_id=candidate.user_id
        and snapshots.refresh_job_id is not null and snapshots.refresh_started_at>now()-interval '15 minutes')
    order by candidate.next_attempt_at limit greatest(1,least(p_limit,5)) for update skip locked
  ) returning jobs.*;
$$;
revoke all on function public.claim_creator_content_indexes(integer) from public,anon,authenticated;
grant execute on function public.claim_creator_content_indexes(integer) to service_role;

-- Previously imported image posts can be indexed without another provider fetch.
update public.social_content_insights set media_sources=jsonb_build_array(jsonb_build_object(
  'id',remote_post_id||':legacy-image','type','image','url',thumbnail_url
)) where content_type in ('image','carousel') and thumbnail_url is not null and media_sources='[]'::jsonb;
insert into public.creator_content_index_jobs(user_id)
  select distinct user_id from public.social_content_insights on conflict(user_id) do nothing;
notify pgrst,'reload schema';
