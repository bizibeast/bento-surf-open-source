alter table public.seo_runs
  add column publication_slot text not null default '10:00'
  check (publication_slot in ('10:00', '17:00'));

drop index public.seo_runs_publication_date_unique;
create unique index seo_runs_publication_slot_unique
  on public.seo_runs(environment, publication_date, publication_slot)
  where kind = 'publication';
