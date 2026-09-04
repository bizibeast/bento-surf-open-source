begin;

alter table public.social_analytics_snapshots
  add column if not exists history_imported_at timestamptz;

alter table public.social_content_insights
  add column if not exists views bigint;

alter table public.social_content_insights
  drop constraint if exists social_content_insights_views_check;

alter table public.social_content_insights
  add constraint social_content_insights_views_check check (views is null or views >= 0);

update public.social_content_insights
set views = impressions,
    impressions = null
where provider in ('instagram', 'threads', 'tiktok', 'youtube')
  and views is null
  and impressions is not null;

-- Instagram's historical follower_count insight is not a dated absolute total.
-- Keep only point-in-time snapshots captured by Bento from this release onward.
update public.social_analytics_history
set followers = null
where provider = 'instagram';

insert into public.social_analytics_history (
  connection_id,
  user_id,
  provider,
  followers,
  following,
  posts,
  views,
  reach,
  engagements,
  status,
  captured_at
)
select
  connection_id,
  user_id,
  provider,
  followers,
  following,
  posts,
  views,
  reach,
  engagements,
  status,
  now()
from public.social_analytics_snapshots
where provider = 'instagram'
  and followers is not null;

notify pgrst, 'reload schema';

commit;
