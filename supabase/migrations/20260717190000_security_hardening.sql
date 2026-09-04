begin;

-- Public profiles are assembled by the Worker with an explicit column list.
-- Do not expose complete profile, page, or block tables through PostgREST.
drop policy if exists "profiles_public_read" on public.profiles;
drop policy if exists "pages_public_read" on public.pages;
drop policy if exists "blocks_public_read" on public.blocks;

revoke select on public.profiles from anon, authenticated;
revoke select on public.pages from anon;
revoke select on public.blocks from anon;

grant select (
  id, username, display_name, bio, avatar_url, cover_url, theme, accent_color,
  is_pro, badge_hidden, onboarded, created_at, updated_at, noindex, font,
  meta_title, meta_description, primary_font, secondary_font, header_mode,
  pattern, pattern_settings
) on public.profiles to authenticated;

drop policy if exists "profiles_owner_read" on public.profiles;
create policy "profiles_owner_read"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

-- Analytics and leads enter through bounded, rate-limited Worker endpoints.
-- These legacy policies let a publishable Supabase key bypass those controls.
drop policy if exists "bc_public_insert" on public.block_clicks;
drop policy if exists "pv_public_insert" on public.profile_views;
drop policy if exists "email_signups_public_insert" on public.email_signups;
revoke insert on public.block_clicks from anon, authenticated;
revoke insert on public.profile_views from anon, authenticated;
revoke insert on public.email_signups from anon, authenticated;

-- New media is written only through the authenticated R2 upload endpoint. Keep
-- legacy objects readable, but remove obsolete direct Supabase Storage writes.
drop policy if exists "uploads_owner_insert" on storage.objects;
drop policy if exists "uploads_owner_update" on storage.objects;
drop policy if exists "uploads_owner_delete" on storage.objects;
drop policy if exists "avatars_owner_insert" on storage.objects;
drop policy if exists "avatars_owner_update" on storage.objects;
drop policy if exists "avatars_owner_delete" on storage.objects;

-- Public Instagram previews use Bright Data, so the OAuth token is not needed
-- after account discovery. Purge previously retained bearer credentials.
update public.social_connections
set access_token = '', token_expires_at = null
where access_token <> '' or token_expires_at is not null;

-- RLS is not an input validator. These NOT VALID constraints protect every new
-- direct PostgREST write without making deployment depend on cleaning old rows.
alter table public.profiles
  add constraint profiles_display_name_size
    check (octet_length(display_name) <= 240) not valid,
  add constraint profiles_bio_size
    check (octet_length(bio) <= 1120) not valid,
  add constraint profiles_pattern_settings_size
    check (octet_length(pattern_settings::text) <= 20000) not valid,
  add constraint profiles_avatar_url_scheme
    check (
      avatar_url is null or
      (octet_length(avatar_url) <= 2048 and avatar_url ~* '^https?://')
    ) not valid;

alter table public.pages
  add constraint pages_name_size
    check (char_length(name) between 1 and 40) not valid,
  add constraint pages_url_scheme
    check (
      url is null or
      (octet_length(url) <= 2048 and url ~* '^https?://')
    ) not valid;

alter table public.blocks
  add constraint blocks_content_size
    check (octet_length(content::text) <= 100000) not valid,
  add constraint blocks_cover_url_scheme
    check (
      cover_url is null or
      (octet_length(cover_url) <= 2048 and cover_url ~* '^https?://')
    ) not valid,
  add constraint blocks_geometry_bounds
    check (x >= 0 and y >= 0 and w between 1 and 4 and h between 1 and 6) not valid;

alter table public.commerce_products
  add constraint commerce_products_settings_size
    check (octet_length(settings::text) <= 100000) not valid,
  add constraint commerce_products_text_size
    check (
      char_length(title) between 1 and 120 and
      char_length(subtitle) <= 240 and
      char_length(description) <= 20000
    ) not valid,
  add constraint commerce_products_cover_url_scheme
    check (
      cover_url is null or
      (octet_length(cover_url) <= 2048 and cover_url ~* '^https?://')
    ) not valid;

-- SECURITY DEFINER helpers should never inherit PostgreSQL's default PUBLIC
-- execute privilege. Re-assert the intended roles for legacy functions.
revoke all on function public.track_event(text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.track_event(text, uuid, uuid, text, text) to service_role;

commit;

notify pgrst, 'reload schema';
