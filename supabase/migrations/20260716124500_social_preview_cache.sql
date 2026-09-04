-- Shared social-preview cache. Keeping successful upstream responses in the
-- database prevents every Worker isolate and every card instance from hitting
-- rate-limited social APIs independently.
create table public.social_preview_cache (
  cache_key text primary key,
  platform text not null,
  handle text not null,
  preview jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  stale_until timestamptz not null,
  constraint social_preview_cache_platform_check check (
    platform in (
      'instagram', 'twitter', 'tiktok', 'linkedin', 'youtube',
      'github', 'gitlab', 'reddit', 'bluesky', 'mastodon'
    )
  ),
  constraint social_preview_cache_handle_check check (length(handle) between 1 and 100),
  constraint social_preview_cache_expiry_check check (stale_until >= expires_at)
);

create index social_preview_cache_expiry_idx
  on public.social_preview_cache(expires_at);

alter table public.social_preview_cache enable row level security;
revoke all on public.social_preview_cache from anon, authenticated;
grant all on public.social_preview_cache to service_role;
