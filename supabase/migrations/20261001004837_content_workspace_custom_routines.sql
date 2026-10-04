-- Keep existing built-ins unique while allowing independently scheduled custom routines.
alter table public.content_routines drop constraint content_routines_template_check;
alter table public.content_routines add constraint content_routines_template_check check (
  template in ('nightly_niche_brief', 'fill_schedule', 'morning_ready_email', 'weekly_performance_review')
  or template ~ '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
);
notify pgrst, 'reload schema';
