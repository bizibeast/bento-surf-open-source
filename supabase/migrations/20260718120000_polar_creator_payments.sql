-- Creator-owned payment accounts. Provider credentials are encrypted by the
-- application before storage. Platform fees are calculated from the creator's
-- server-side plan and recorded on every checkout/order.

alter table public.profiles
  add column if not exists commerce_payment_provider text;

alter table public.profiles
  drop constraint if exists profiles_commerce_payment_provider_check;
alter table public.profiles
  add constraint profiles_commerce_payment_provider_check
  check (
    commerce_payment_provider is null or
    commerce_payment_provider in ('stripe', 'paypal', 'razorpay', 'polar', 'dodo')
  );

alter table public.creator_payment_accounts
  drop constraint if exists creator_payment_accounts_creator_id_key;
alter table public.creator_payment_accounts
  drop constraint if exists creator_payment_accounts_provider_account_id_key;

alter table public.creator_payment_accounts
  add column if not exists access_token_ciphertext text,
  add column if not exists refresh_token_ciphertext text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists scopes text[] not null default '{}',
  add column if not exists webhook_endpoint_id text,
  add column if not exists webhook_secret_ciphertext text,
  add column if not exists provider_metadata jsonb not null default '{}'::jsonb;

alter table public.creator_payment_accounts
  drop constraint if exists creator_payment_accounts_creator_provider_key;
alter table public.creator_payment_accounts
  drop constraint if exists creator_payment_accounts_provider_account_key;
alter table public.creator_payment_accounts
  add constraint creator_payment_accounts_creator_provider_key
  unique (creator_id, provider);
alter table public.creator_payment_accounts
  add constraint creator_payment_accounts_provider_account_key
  unique (provider, provider_account_id);

-- Connections are read only through authenticated Worker functions with an
-- explicit creator_id filter. Browser roles cannot enumerate provider account
-- identifiers or select encrypted tokens and webhook secrets.
revoke all on public.creator_payment_accounts from anon, authenticated;

create table if not exists public.payment_oauth_states (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  state_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_oauth_states_expiry_idx
  on public.payment_oauth_states(expires_at);

alter table public.payment_oauth_states enable row level security;
grant all on public.payment_oauth_states to service_role;

create table if not exists public.commerce_payment_sessions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.creator_payment_accounts(id) on delete cascade,
  provider text not null,
  provider_checkout_id text,
  buyer_email text not null,
  buyer_name text,
  gross_amount integer not null check (gross_amount >= 0),
  platform_fee_bps integer not null check (platform_fee_bps between 0 and 10000),
  platform_fee_amount integer not null check (platform_fee_amount >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  access_token_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'paid', 'expired', 'canceled', 'failed')),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_checkout_id)
);

create index if not exists commerce_payment_sessions_creator_idx
  on public.commerce_payment_sessions(creator_id, created_at desc);
create index if not exists commerce_payment_sessions_expiry_idx
  on public.commerce_payment_sessions(expires_at);

alter table public.commerce_payment_sessions enable row level security;
grant all on public.commerce_payment_sessions to service_role;

create table if not exists public.commerce_product_provider_refs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_account_id text not null,
  provider_product_id text not null,
  provider_price_id text,
  sync_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, provider, provider_account_id)
);

create index if not exists commerce_product_provider_refs_creator_idx
  on public.commerce_product_provider_refs(creator_id, provider);

alter table public.commerce_product_provider_refs enable row level security;
grant select on public.commerce_product_provider_refs to authenticated;
grant all on public.commerce_product_provider_refs to service_role;

drop policy if exists commerce_product_provider_refs_owner_read
  on public.commerce_product_provider_refs;
create policy commerce_product_provider_refs_owner_read
  on public.commerce_product_provider_refs for select
  to authenticated
  using (auth.uid() = creator_id);

drop trigger if exists commerce_product_provider_refs_updated_at
  on public.commerce_product_provider_refs;
create trigger commerce_product_provider_refs_updated_at
  before update on public.commerce_product_provider_refs
  for each row execute function public.tg_set_updated_at();

drop trigger if exists commerce_payment_sessions_updated_at
  on public.commerce_payment_sessions;
create trigger commerce_payment_sessions_updated_at
  before update on public.commerce_payment_sessions
  for each row execute function public.tg_set_updated_at();

alter table public.commerce_orders
  add column if not exists provider_account_id text;

alter table public.commerce_orders
  drop constraint if exists commerce_orders_provider_payment_key;
alter table public.commerce_orders
  add constraint commerce_orders_provider_payment_key
  unique (provider, provider_payment_id);

create or replace function public.fulfill_provider_commerce_order(
  p_product_id uuid,
  p_buyer_email text,
  p_buyer_name text,
  p_provider text,
  p_provider_account_id text,
  p_provider_checkout_id text,
  p_provider_payment_id text,
  p_provider_subscription_id text,
  p_gross_amount integer,
  p_platform_fee_bps integer,
  p_platform_fee_amount integer,
  p_processor_fee_amount integer,
  p_tax_amount integer,
  p_net_amount integer,
  p_currency text,
  p_metadata jsonb,
  p_access_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  product public.commerce_products%rowtype;
  created_order public.commerce_orders%rowtype;
begin
  select * into created_order
  from public.commerce_orders
  where provider = p_provider and provider_payment_id = p_provider_payment_id;

  if created_order.id is not null then
    return jsonb_build_object(
      'order_id', created_order.id,
      'product_id', created_order.product_id,
      'creator_id', created_order.creator_id,
      'already_processed', true
    );
  end if;

  select * into product
  from public.commerce_products
  where id = p_product_id
  for update;

  if product.id is null then raise exception 'Product was not found'; end if;
  if product.inventory_limit is not null and product.sales_count >= product.inventory_limit then
    raise exception 'This product is sold out';
  end if;
  if p_gross_amount < 0 or p_net_amount < 0 or p_platform_fee_amount < 0
    or p_processor_fee_amount < 0 or p_tax_amount < 0 then
    raise exception 'Invalid order amounts';
  end if;
  if lower(p_currency) <> product.currency then
    raise exception 'Order currency does not match product';
  end if;

  insert into public.commerce_orders(
    product_id, creator_id, buyer_email, buyer_name, status, provider,
    provider_account_id, provider_checkout_id, provider_payment_id,
    provider_subscription_id, gross_amount, platform_fee_bps,
    platform_fee_amount, processor_fee_amount, tax_amount, net_amount, currency,
    metadata, paid_at
  ) values (
    product.id, product.creator_id, lower(p_buyer_email), nullif(p_buyer_name, ''),
    'paid', p_provider, p_provider_account_id, p_provider_checkout_id,
    p_provider_payment_id, nullif(p_provider_subscription_id, ''), p_gross_amount,
    p_platform_fee_bps, p_platform_fee_amount, p_processor_fee_amount,
    p_tax_amount, p_net_amount, lower(p_currency), coalesce(p_metadata, '{}'::jsonb), now()
  )
  on conflict (provider, provider_payment_id) do nothing
  returning * into created_order;

  if created_order.id is null then
    select * into created_order
    from public.commerce_orders
    where provider = p_provider and provider_payment_id = p_provider_payment_id;
  else
    if p_access_token_hash is not null then
      insert into public.commerce_access_grants(
        order_id, product_id, creator_id, buyer_email, token_hash
      ) values (
        created_order.id, product.id, product.creator_id,
        lower(p_buyer_email), p_access_token_hash
      ) on conflict (token_hash) do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'order_id', created_order.id,
    'product_id', created_order.product_id,
    'creator_id', created_order.creator_id,
    'already_processed', false
  );
end;
$$;

revoke all on function public.fulfill_provider_commerce_order(
  uuid, text, text, text, text, text, text, text, integer, integer, integer,
  integer, integer, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.fulfill_provider_commerce_order(
  uuid, text, text, text, text, text, text, text, integer, integer, integer,
  integer, integer, integer, text, jsonb, text
) to service_role;
