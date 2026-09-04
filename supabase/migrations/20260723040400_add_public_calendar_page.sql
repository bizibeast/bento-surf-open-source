-- Creators can publish a dedicated calendar storefront at
-- bento.surf/:username/calendar. It stays private until the creator opts in.
alter table public.profiles
  add column if not exists calendar_page_enabled boolean not null default false;

comment on column public.profiles.calendar_page_enabled is
  'Whether the creator public calendar storefront is published.';

-- Profiles use explicit column allowlists. The anonymous grant exposes the
-- column to PostgREST's schema cache, but no anonymous RLS policy exists, so it
-- does not expose profile rows. Public reads continue through the Worker.
grant select (calendar_page_enabled) on public.profiles to anon, authenticated;

notify pgrst, 'reload schema';
