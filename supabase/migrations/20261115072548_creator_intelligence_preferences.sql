alter table public.creator_content_profiles
  add column intelligence_preferences jsonb not null default '{}'::jsonb,
  add constraint creator_content_profiles_intelligence_preferences_check check (
    jsonb_typeof(intelligence_preferences) = 'object'
    and (intelligence_preferences - array['audience', 'voice', 'priorities']) = '{}'::jsonb
    and (not (intelligence_preferences ? 'audience') or (
      jsonb_typeof(intelligence_preferences -> 'audience') = 'string'
      and char_length(intelligence_preferences ->> 'audience') <= 300
    ))
    and (not (intelligence_preferences ? 'voice') or (
      jsonb_typeof(intelligence_preferences -> 'voice') = 'string'
      and char_length(intelligence_preferences ->> 'voice') <= 600
    ))
    and (not (intelligence_preferences ? 'priorities') or (
      jsonb_typeof(intelligence_preferences -> 'priorities') = 'string'
      and char_length(intelligence_preferences ->> 'priorities') <= 400
    ))
  );

notify pgrst, 'reload schema';
