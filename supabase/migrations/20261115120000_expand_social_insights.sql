alter table public.social_content_insights
  add column detail_metrics jsonb not null default '{}'::jsonb;

alter table public.social_analytics_history
  add column detail_metrics jsonb not null default '{}'::jsonb;

alter table public.social_analytics_snapshots
  add column period_metrics jsonb not null default '{}'::jsonb,
  add column content_archive_cursor text,
  add column content_archive_completed_at timestamptz;

create table public.instagram_audio_connections (
  connection_id uuid primary key references public.social_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  instagram_user_id text not null check (instagram_user_id ~ '^[0-9]{1,30}$'),
  access_token text not null,
  expires_at timestamptz
);

alter table public.instagram_audio_connections enable row level security;
revoke all on public.instagram_audio_connections from public, anon, authenticated;
grant all on public.instagram_audio_connections to service_role;
