alter table public.profiles
  add column if not exists calendar_page_name text not null default 'Calendar'
  check (char_length(btrim(calendar_page_name)) between 1 and 40);

comment on column public.profiles.calendar_page_name is
  'Creator-editable label for the public calendar page.';

grant select (calendar_page_name) on public.profiles to anon, authenticated;
grant update (calendar_page_name) on public.profiles to authenticated;

notify pgrst, 'reload schema';
