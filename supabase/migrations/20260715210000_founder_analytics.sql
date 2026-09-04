-- Founder analytics source of truth. Product behavior is explored in PostHog,
-- while users, entitlements, cash movement, and webhook history stay in Postgres.

alter table public.subscriptions
  add column if not exists dodo_subscription_id text,
  add column if not exists product_id text,
  add column if not exists customer_id text,
  add column if not exists amount integer,
  add column if not exists currency text,
  add column if not exists billing_interval text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists canceled_at timestamptz;

update public.subscriptions
set dodo_subscription_id = stripe_subscription_id,
    product_id = price_id
where dodo_subscription_id is null or product_id is null;

create unique index if not exists subscriptions_dodo_subscription_id_idx
  on public.subscriptions(dodo_subscription_id)
  where dodo_subscription_id is not null;

create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  webhook_id text not null unique,
  event_type text not null,
  user_id uuid references auth.users(id) on delete set null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  error_message text,
  occurred_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_events_created_at_idx on public.billing_events(created_at desc);
create index billing_events_status_idx on public.billing_events(status, created_at desc);
create index billing_events_user_id_idx on public.billing_events(user_id, created_at desc);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_id text not null unique,
  user_id uuid references auth.users(id) on delete set null,
  subscription_id text,
  checkout_session_id text,
  product_id text,
  status text not null,
  total_amount integer not null default 0 check (total_amount >= 0),
  settlement_amount integer check (settlement_amount is null or settlement_amount >= 0),
  currency text not null,
  settlement_currency text,
  tax integer check (tax is null or tax >= 0),
  refund_status text,
  payment_method text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payments_user_id_idx on public.payments(user_id, created_at desc);
create index payments_status_idx on public.payments(status, created_at desc);
create index payments_subscription_id_idx on public.payments(subscription_id);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  refund_id text not null unique,
  payment_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text not null,
  amount integer not null default 0 check (amount >= 0),
  currency text not null,
  reason text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index refunds_payment_id_idx on public.refunds(payment_id);
create index refunds_user_id_idx on public.refunds(user_id, created_at desc);
create index refunds_status_idx on public.refunds(status, created_at desc);

alter table public.billing_events enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;

revoke all on public.billing_events from anon, authenticated;
revoke all on public.payments from anon, authenticated;
revoke all on public.refunds from anon, authenticated;
grant all on public.billing_events to service_role;
grant all on public.payments to service_role;
grant all on public.refunds to service_role;

create trigger billing_events_updated_at
  before update on public.billing_events
  for each row execute function public.tg_set_updated_at();

create trigger payments_updated_at
  before update on public.payments
  for each row execute function public.tg_set_updated_at();

create trigger refunds_updated_at
  before update on public.refunds
  for each row execute function public.tg_set_updated_at();
