create table public.benny_ai_providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  model text not null check (char_length(model) between 1 and 180),
  encrypted_api_key text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, owner_id, id)
);

create table public.benny_ai_provider_defaults (
  workspace_id uuid not null,
  owner_id uuid not null,
  provider_id uuid not null,
  primary key (workspace_id, owner_id),
  foreign key (workspace_id, owner_id, provider_id)
    references public.benny_ai_providers (workspace_id, owner_id, id) on delete cascade
);

alter table public.benny_ai_providers enable row level security;
alter table public.benny_ai_provider_defaults enable row level security;
revoke all on public.benny_ai_providers, public.benny_ai_provider_defaults
  from public, anon, authenticated;
grant select, insert, update, delete on public.benny_ai_providers, public.benny_ai_provider_defaults
  to service_role;
