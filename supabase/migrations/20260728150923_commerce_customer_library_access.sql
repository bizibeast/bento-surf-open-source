-- Short-lived, hashed capabilities issued from an authenticated customer
-- library session. These preserve every existing purchase URL while allowing a
-- customer to open any owned item from one passwordless library.

create table public.commerce_customer_access_tokens (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.commerce_customers(id) on delete cascade,
  grant_id uuid not null references public.commerce_access_grants(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index commerce_customer_access_tokens_active_idx
  on public.commerce_customer_access_tokens(token_hash, expires_at);
create index commerce_customer_access_tokens_customer_idx
  on public.commerce_customer_access_tokens(customer_id, created_at desc);
create index commerce_customer_access_tokens_grant_idx
  on public.commerce_customer_access_tokens(grant_id, created_at desc);

alter table public.commerce_customer_access_tokens enable row level security;
revoke all on public.commerce_customer_access_tokens from anon, authenticated;
grant all on public.commerce_customer_access_tokens to service_role;

create policy commerce_customer_access_tokens_client_deny
  on public.commerce_customer_access_tokens for all to anon, authenticated
  using (false)
  with check (false);

comment on table public.commerce_customer_access_tokens is
  'Short-lived hashed access capabilities issued only after a customer library session is verified.';
