alter table public.creator_content_recommendations
  add column if not exists metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(metadata) = 'object');

alter table public.creator_content_recommendations
  drop constraint if exists creator_content_recommendations_feedback_check;

alter table public.creator_content_recommendations
  add constraint creator_content_recommendations_feedback_check
  check (feedback in ('pending', 'liked', 'saved', 'not_relevant'));
