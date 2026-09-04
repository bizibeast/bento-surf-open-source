-- Allow X Auto-DM rules for likes and reposts, matching Instagram comment/share triggers.
-- Event bodies are still processed ephemerally; only delivery metadata is stored.

alter table public.twitter_dm_automations
  drop constraint if exists twitter_dm_automations_trigger_check;

alter table public.twitter_dm_automations
  add constraint twitter_dm_automations_trigger_check check (
    trigger_type in (
      'dm_keyword',
      'any_dm',
      'mention_keyword',
      'any_mention',
      'any_like',
      'any_retweet'
    )
  );

alter table public.twitter_dm_automations
  drop constraint if exists twitter_dm_automations_keywords_required;

alter table public.twitter_dm_automations
  add constraint twitter_dm_automations_keywords_required check (
    trigger_type in ('any_dm', 'any_mention', 'any_like', 'any_retweet')
    or cardinality(keywords) > 0
  );

alter table public.twitter_dm_events
  drop constraint if exists twitter_dm_events_type_check;

alter table public.twitter_dm_events
  add constraint twitter_dm_events_type_check check (
    event_type in ('dm', 'mention', 'like', 'retweet')
  );
