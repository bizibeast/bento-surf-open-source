-- The Pages Search API uses the person's Facebook token. Keep it encrypted,
-- server-only, alongside the Page token used for publishing.
alter table public.social_connections
  add column if not exists facebook_user_access_token text;
