-- Discover can use confirmed, creator-owned Brain context alongside explicit topics.
alter table public.creator_content_profiles
  add column if not exists discover_use_brain boolean not null default true;
