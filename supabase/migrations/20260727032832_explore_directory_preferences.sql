-- Public Explore directory controls. Creator pages are already public, but this
-- explicit preference controls whether they are promoted in the directory.
alter table public.profiles
  add column if not exists show_in_explore boolean not null default true,
  add column if not exists explore_category text not null default 'creator';

alter table public.profiles
  drop constraint if exists profiles_explore_category_check;

alter table public.profiles
  add constraint profiles_explore_category_check
  check (
    explore_category in (
      'creator',
      'designer',
      'developer',
      'artist',
      'photographer',
      'founder',
      'business',
      'marketer',
      'educator'
    )
  );

create index if not exists profiles_explore_directory_idx
  on public.profiles (explore_category, updated_at desc)
  where show_in_explore = true
    and onboarded = true
    and noindex = false;

comment on column public.profiles.show_in_explore is
  'Whether this already-public creator page may be promoted in the Explore directory.';
comment on column public.profiles.explore_category is
  'Creator-selected Explore category shared by onboarding, Settings, and the public directory.';
