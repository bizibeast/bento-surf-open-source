-- Per-user derived interests and checked public profiles. Existing profile RLS applies.
alter table public.creator_content_profiles
  add column if not exists discover_research jsonb;
