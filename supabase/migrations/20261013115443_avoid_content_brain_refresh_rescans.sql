-- A provider refresh updates fetched_at even when the post has not changed.
-- That timestamp is not Brain input and must not restart source or media work.
create or replace function public.queue_creator_content_index() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='INSERT' or old.caption is distinct from new.caption
    or old.media_sources is distinct from new.media_sources
    or old.content_type is distinct from new.content_type then
    insert into creator_content_media(user_id,connection_id,post_id,asset_id,provider,media_type,remote_url,source_url,caption)
      select new.user_id,new.connection_id,new.remote_post_id,asset.id,new.provider,asset.type,asset.url,new.remote_post_url,left(coalesce(new.caption,''),10000)
      from jsonb_to_recordset(new.media_sources) as asset(id text,type text,url text)
      where asset.id is not null and asset.type in ('image','video','thumbnail')
      on conflict(connection_id,post_id,asset_id) do update set caption=excluded.caption,source_url=excluded.source_url,remote_url=excluded.remote_url,
        status=case when creator_content_media.status='ready' then 'ready' when creator_content_media.status='unavailable' or creator_content_media.remote_url is distinct from excluded.remote_url then 'pending' else creator_content_media.status end,
        updated_at=now()
      where creator_content_media.caption is distinct from excluded.caption
        or creator_content_media.source_url is distinct from excluded.source_url
        or creator_content_media.remote_url is distinct from excluded.remote_url;
    perform request_creator_content_index(new.user_id,false);
  end if;
  return new;
end; $$;

drop trigger social_posts_queue_content_index on public.social_content_insights;
create trigger social_posts_queue_content_index after insert or update of caption,media_sources,content_type
  on public.social_content_insights for each row execute function public.queue_creator_content_index();
