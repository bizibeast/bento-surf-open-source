create table if not exists public.social_content_insights (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  remote_post_id text not null,
  remote_post_url text,
  content_type text not null default 'other',
  caption text,
  thumbnail_url text,
  published_at timestamptz not null,
  impressions bigint,
  reach bigint,
  engagements bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  fetched_at timestamptz not null default now(),
  constraint social_content_insights_connection_post_unique unique(connection_id, remote_post_id),
  constraint social_content_insights_type_check check (
    content_type in ('text', 'image', 'video', 'carousel', 'link', 'other')
  ),
  constraint social_content_insights_metrics_check check (
    (impressions is null or impressions >= 0) and
    (reach is null or reach >= 0) and
    (engagements is null or engagements >= 0) and
    (likes is null or likes >= 0) and
    (comments is null or comments >= 0) and
    (shares is null or shares >= 0) and
    (saves is null or saves >= 0)
  )
);

create index if not exists social_content_insights_account_idx
  on public.social_content_insights(connection_id, published_at desc);

create index if not exists social_content_insights_user_idx
  on public.social_content_insights(user_id, published_at desc);

alter table public.social_content_insights enable row level security;
revoke all on public.social_content_insights from public, anon, authenticated;
grant all on public.social_content_insights to service_role;
