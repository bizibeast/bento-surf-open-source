create table public.content_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null
    check (provider in ('telegram', 'notion', 'github', 'granola', 'slack')),
  external_account_id text not null check (length(external_account_id) between 1 and 500),
  display_name text check (display_name is null or length(display_name) <= 160),
  status text not null default 'active'
    check (status in ('active', 'expired', 'disconnected', 'error')),
  scopes text[] not null default '{}'
    check (cardinality(scopes) <= 50),
  selected_resources jsonb not null default '{}'::jsonb
    check (jsonb_typeof(selected_resources) = 'object'),
  access_token_ciphertext text
    check (access_token_ciphertext is null or length(access_token_ciphertext) <= 10000),
  refresh_token_ciphertext text
    check (refresh_token_ciphertext is null or length(refresh_token_ciphertext) <= 10000),
  token_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  sync_cursor text check (sync_cursor is null or length(sync_cursor) <= 2000),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, external_account_id)
);

create unique index content_connections_telegram_chat_unique
  on public.content_connections(external_account_id)
  where provider = 'telegram';

create index content_connections_user_provider_idx
  on public.content_connections(user_id, provider, created_at desc);

create table public.content_connection_states (
  state uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null
    check (provider in ('telegram', 'notion', 'github', 'granola', 'slack')),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now()
);

create index content_connection_states_expiry_idx
  on public.content_connection_states(expires_at);
create index content_connection_states_user_provider_idx
  on public.content_connection_states(user_id, provider);

create table public.telegram_update_receipts (
  update_id bigint primary key check (update_id >= 0),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  lease_expires_at timestamptz,
  error_message text check (error_message is null or length(error_message) <= 1000),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index telegram_update_receipts_expiry_idx
  on public.telegram_update_receipts(expires_at);
create index telegram_update_receipts_lease_idx
  on public.telegram_update_receipts(lease_expires_at)
  where status = 'processing';

create table public.telegram_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  connection_id uuid not null references public.content_connections(id) on delete cascade,
  action_type text not null check (action_type in ('approve_schedule', 'approve_brain')),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index telegram_actions_expiry_idx on public.telegram_actions(expires_at);
create index telegram_actions_connection_idx
  on public.telegram_actions(connection_id, created_at desc);

create trigger content_connections_updated_at
  before update on public.content_connections
  for each row execute function public.tg_set_updated_at();
create trigger telegram_update_receipts_updated_at
  before update on public.telegram_update_receipts
  for each row execute function public.tg_set_updated_at();

alter table public.content_connections enable row level security;
alter table public.content_connection_states enable row level security;
alter table public.telegram_update_receipts enable row level security;
alter table public.telegram_actions enable row level security;

revoke all on public.content_connections from public, anon;
revoke all on public.content_connection_states from public, anon, authenticated;
revoke all on public.telegram_update_receipts from public, anon, authenticated;
revoke all on public.telegram_actions from public, anon, authenticated;

grant select, insert, update, delete on public.content_connections to authenticated;
grant all on public.content_connections to service_role;
grant all on public.content_connection_states to service_role;
grant all on public.telegram_update_receipts to service_role;
grant all on public.telegram_actions to service_role;

create policy content_connections_owner_all
  on public.content_connections for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_now timestamptz default now()
)
returns setof public.telegram_update_receipts
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.telegram_update_receipts
  set status = 'processing',
      attempts = attempts + 1,
      lease_expires_at = p_now + interval '5 minutes',
      error_message = null,
      updated_at = p_now
  where update_id = p_update_id
    and expires_at > p_now
    and attempts < 10
    and (
      status in ('received', 'failed')
      or (status = 'processing' and lease_expires_at <= p_now)
    )
  returning *;
end;
$$;

create or replace function public.finish_telegram_update(
  p_update_id bigint,
  p_status text,
  p_error_message text default null,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  if p_status not in ('processed', 'failed') then
    raise exception 'invalid Telegram update status';
  end if;

  update public.telegram_update_receipts
  set status = p_status,
      payload = case when p_status = 'processed' then '{}'::jsonb else payload end,
      lease_expires_at = null,
      error_message = case when p_status = 'failed' then left(p_error_message, 1000) else null end,
      updated_at = p_now
  where update_id = p_update_id
    and status = 'processing';

  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.claim_telegram_action(
  p_action_id uuid,
  p_chat_id text,
  p_now timestamptz default now()
)
returns setof public.telegram_actions
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.telegram_actions as action
  set consumed_at = p_now
  from public.content_connections as connection
  where action.id = p_action_id
    and action.connection_id = connection.id
    and connection.provider = 'telegram'
    and connection.status = 'active'
    and connection.external_account_id = p_chat_id
    and action.consumed_at is null
    and action.expires_at > p_now
  returning action.*;
end;
$$;

revoke all on function public.claim_telegram_update(bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.finish_telegram_update(bigint, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_telegram_action(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_telegram_update(bigint, timestamptz) to service_role;
grant execute on function public.finish_telegram_update(bigint, text, text, timestamptz) to service_role;
grant execute on function public.claim_telegram_action(uuid, text, timestamptz) to service_role;
