create table if not exists public.commerce_download_events (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.commerce_access_grants(id) on delete cascade,
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  asset_id text not null check (asset_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  outcome text not null check (outcome in ('verified', 'downloaded', 'missing')),
  object_size bigint check (object_size is null or object_size >= 0),
  created_at timestamptz not null default now()
);

create index if not exists commerce_download_events_creator_created_idx
  on public.commerce_download_events(creator_id, created_at desc);
create index if not exists commerce_download_events_grant_created_idx
  on public.commerce_download_events(grant_id, created_at desc);

alter table public.commerce_download_events enable row level security;
revoke all on public.commerce_download_events from anon, authenticated;
grant all on public.commerce_download_events to service_role;

create policy commerce_download_events_client_deny
  on public.commerce_download_events
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.commerce_download_events is
  'Service-role-only audit trail for verified, completed, and missing private commerce downloads. Capability tokens and buyer network identifiers are deliberately excluded.';

-- Rollback:
-- drop table if exists public.commerce_download_events;
