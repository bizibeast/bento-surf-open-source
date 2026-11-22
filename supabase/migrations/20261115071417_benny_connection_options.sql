alter table public.benny_ai_providers
  add column provider_kind text not null default 'openrouter'
    check (provider_kind in ('openrouter', 'openai', 'compatible')),
  add column base_url text,
  add column additional_models text[] not null default '{}' check (cardinality(additional_models) <= 8),
  add constraint benny_provider_base_url_matches_kind check (
    (provider_kind = 'compatible' and base_url is not null and char_length(base_url) <= 300)
    or (provider_kind <> 'compatible' and base_url is null)
  );

create table public.benny_search_credentials (
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  encrypted_api_key text not null,
  primary key (workspace_id, owner_id)
);

alter table public.benny_search_credentials enable row level security;
revoke all on public.benny_search_credentials from public, anon, authenticated;
grant select, insert, update, delete on public.benny_search_credentials to service_role;
