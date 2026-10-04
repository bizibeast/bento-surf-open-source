alter table public.content_connection_states
  add column metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 20000);

alter table public.content_connections
  add constraint content_connections_id_user_unique unique (id, user_id);

create table public.content_source_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  connection_id uuid not null,
  provider text not null
    check (provider in ('notion', 'github', 'granola', 'slack')),
  external_item_id text not null check (length(external_item_id) between 1 and 500),
  record_type text not null check (length(record_type) between 1 and 80),
  title text not null check (length(title) between 1 and 300),
  body text not null default '' check (length(body) <= 20000),
  canonical_source_url text
    check (canonical_source_url is null or length(canonical_source_url) <= 2000),
  occurred_at timestamptz,
  retrieved_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 20000),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, user_id)
    references public.content_connections(id, user_id) on delete cascade,
  unique (connection_id, external_item_id)
);

create index content_source_records_user_recent_idx
  on public.content_source_records(user_id, occurred_at desc nulls last, retrieved_at desc)
  where deleted_at is null;
create index content_source_records_connection_idx
  on public.content_source_records(connection_id, retrieved_at desc);

create trigger content_source_records_updated_at
  before update on public.content_source_records
  for each row execute function public.tg_set_updated_at();

alter table public.content_source_records enable row level security;

revoke all on public.content_source_records from public, anon, authenticated;
grant select on public.content_source_records to authenticated;
grant all on public.content_source_records to service_role;

create policy content_source_records_owner_all
  on public.content_source_records for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.content_connection_states from public, anon, authenticated;

alter table public.creator_brain_items
  drop constraint if exists creator_brain_items_provenance_check;
alter table public.creator_brain_items
  add constraint creator_brain_items_provenance_check
  check (provenance in ('creator', 'social_post', 'agent_chat', 'file', 'link', 'integration'));
