-- Instagram returns short-lived, hotlink-protected CDN URLs. Cache each post
-- image in a public system bucket so Bento cards always render a stable URL.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'social-media-cache',
  'social-media-cache',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The old preview rows contain expiring Instagram CDN URLs. Force one clean
-- sync through the durable media pipeline after this migration lands.
delete from public.social_preview_cache where platform = 'instagram';
