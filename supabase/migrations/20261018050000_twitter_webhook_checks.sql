-- Webhook verification needs its own due time and lease. OAuth refreshes run
-- every two hours and must not reset/starve these control-plane checks.
alter table public.social_connections
  add column if not exists twitter_webhook_check_after timestamptz not null default now(),
  add column if not exists twitter_webhook_check_lease_until timestamptz;

create index if not exists social_connections_twitter_webhook_due_idx
  on public.social_connections (twitter_webhook_check_after)
  where provider = 'twitter' and status = 'active' and reauth_required = false;

comment on column public.social_connections.twitter_webhook_check_after is
  'Server-only bounded X webhook audit due time, separate from OAuth renewal.';
comment on column public.social_connections.twitter_webhook_check_lease_until is
  'Server-only compare-and-set lease preventing overlapping X webhook registration.';
