alter table public.social_connections
  drop constraint if exists social_connections_provider_check;

alter table public.social_connections
  add constraint social_connections_provider_check
  check (provider in (
    'instagram',
    'facebook',
    'threads',
    'tiktok',
    'linkedin',
    'twitter',
    'youtube',
    'reddit'
  ));

alter table public.social_oauth_states
  drop constraint if exists social_oauth_states_provider_check;

alter table public.social_oauth_states
  add constraint social_oauth_states_provider_check
  check (provider in (
    'instagram',
    'facebook',
    'threads',
    'tiktok',
    'linkedin',
    'twitter',
    'youtube',
    'reddit'
  ));

alter table public.social_post_targets
  drop constraint if exists social_post_targets_provider_check;

alter table public.social_post_targets
  add constraint social_post_targets_provider_check
  check (provider in (
    'instagram',
    'facebook',
    'threads',
    'tiktok',
    'linkedin',
    'twitter',
    'youtube',
    'reddit'
  ));
