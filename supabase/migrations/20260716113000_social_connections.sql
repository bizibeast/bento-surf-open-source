-- Creator-owned social connections. Provider access tokens are server-only:
-- authenticated clients receive sanitized connection data through server functions.
create table public.social_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_user_id text not null,
  provider_handle text not null,
  access_token text not null,
  token_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_connections_provider_check check (provider in ('instagram')),
  constraint social_connections_handle_check check (
    provider_handle = lower(provider_handle) and length(provider_handle) between 1 and 100
  ),
  unique (provider, provider_user_id)
);

create index social_connections_owner_idx
  on public.social_connections(user_id, provider);
create index social_connections_handle_idx
  on public.social_connections(provider, provider_handle);

alter table public.social_connections enable row level security;
revoke all on public.social_connections from anon, authenticated;
grant all on public.social_connections to service_role;

create trigger social_connections_updated_at
  before update on public.social_connections
  for each row execute function public.tg_set_updated_at();

create table public.social_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now(),
  constraint social_oauth_states_provider_check check (provider in ('instagram'))
);

create index social_oauth_states_expiry_idx on public.social_oauth_states(expires_at);
alter table public.social_oauth_states enable row level security;
revoke all on public.social_oauth_states from anon, authenticated;
grant all on public.social_oauth_states to service_role;
