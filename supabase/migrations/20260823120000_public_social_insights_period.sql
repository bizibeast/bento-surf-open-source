alter table public.profiles
  add column if not exists social_insights_period_days smallint not null default 30;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_social_insights_period_days_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_social_insights_period_days_check
      check (social_insights_period_days in (30, 90, 365));
  end if;
end
$$;

comment on column public.profiles.social_insights_period_days is
  'Content window shown on the public social insights page.';

grant select (social_insights_period_days) on public.profiles to anon, authenticated;
