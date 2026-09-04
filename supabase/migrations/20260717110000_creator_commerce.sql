-- Creator commerce is deliberately separate from Bento's own Pro billing.
-- Dodo continues to bill Bento subscriptions; these tables model products sold
-- by creators, buyer access, and marketplace accounting.

alter type public.block_type add value if not exists 'commerce';

create type public.commerce_product_kind as enum (
  'digital_product',
  'coaching_call',
  'course',
  'webinar',
  'paid_community',
  'membership',
  'custom_product',
  'lead_form',
  'bento_affiliate'
);

create type public.commerce_product_status as enum ('draft', 'published', 'archived');
create type public.commerce_pricing_type as enum ('free', 'one_time', 'subscription');
create type public.commerce_order_status as enum (
  'pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed', 'canceled'
);
create type public.commerce_access_status as enum ('active', 'revoked', 'expired');

create table public.commerce_products (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  kind public.commerce_product_kind not null,
  status public.commerce_product_status not null default 'draft',
  slug text not null unique,
  title text not null,
  subtitle text not null default '',
  description text not null default '',
  cover_url text,
  gallery_urls jsonb not null default '[]'::jsonb,
  pricing_type public.commerce_pricing_type not null default 'one_time',
  price_amount integer not null default 0 check (price_amount >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  billing_interval text check (
    billing_interval is null or billing_interval in ('day', 'week', 'month', 'year')
  ),
  cta_label text not null default 'Get it now',
  settings jsonb not null default '{}'::jsonb,
  inventory_limit integer check (inventory_limit is null or inventory_limit > 0),
  sales_count integer not null default 0 check (sales_count >= 0),
  provider_product_id text,
  provider_price_id text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_products_title_check check (length(title) between 1 and 120),
  constraint commerce_products_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]{2,95}$'),
  constraint commerce_products_pricing_check check (
    (pricing_type = 'free' and price_amount = 0 and billing_interval is null)
    or (pricing_type = 'one_time' and price_amount > 0 and billing_interval is null)
    or (pricing_type = 'subscription' and price_amount > 0 and billing_interval is not null)
  )
);

create index commerce_products_creator_idx
  on public.commerce_products(creator_id, created_at desc);
create index commerce_products_public_idx
  on public.commerce_products(slug)
  where status = 'published';

create table public.commerce_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete restrict,
  creator_id uuid not null references auth.users(id) on delete restrict,
  buyer_email text not null,
  buyer_name text,
  status public.commerce_order_status not null default 'pending',
  provider text not null,
  provider_checkout_id text unique,
  provider_payment_id text unique,
  provider_subscription_id text,
  gross_amount integer not null default 0 check (gross_amount >= 0),
  platform_fee_bps integer not null default 0 check (platform_fee_bps between 0 and 10000),
  platform_fee_amount integer not null default 0 check (platform_fee_amount >= 0),
  processor_fee_amount integer not null default 0 check (processor_fee_amount >= 0),
  tax_amount integer not null default 0 check (tax_amount >= 0),
  net_amount integer not null default 0 check (net_amount >= 0),
  refunded_amount integer not null default 0 check (refunded_amount >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  attribution jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commerce_orders_creator_idx
  on public.commerce_orders(creator_id, created_at desc);
create index commerce_orders_product_idx
  on public.commerce_orders(product_id, created_at desc);
create index commerce_orders_buyer_idx
  on public.commerce_orders(lower(buyer_email), created_at desc);
create index commerce_orders_subscription_idx
  on public.commerce_orders(provider_subscription_id)
  where provider_subscription_id is not null;

-- Lock the product row while an order becomes paid. This keeps inventory and
-- sales counts correct even when multiple checkout/webhook requests arrive at
-- the same time.
create or replace function public.commerce_count_paid_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  should_count boolean := false;
  current_inventory integer;
  current_sales integer;
begin
  if tg_op = 'INSERT' then
    should_count := new.status = 'paid';
  else
    should_count := new.status = 'paid' and old.status is distinct from 'paid';
  end if;

  if should_count then
    select inventory_limit, sales_count
      into current_inventory, current_sales
      from public.commerce_products
      where id = new.product_id
      for update;

    if current_inventory is not null and current_sales >= current_inventory then
      raise exception 'Product is sold out';
    end if;

    update public.commerce_products
      set sales_count = sales_count + 1
      where id = new.product_id;
  end if;
  return new;
end;
$$;

create trigger commerce_orders_count_paid
  before insert or update of status on public.commerce_orders
  for each row execute function public.commerce_count_paid_order();

revoke all on function public.commerce_count_paid_order() from public;

create table public.commerce_access_grants (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  buyer_email text not null,
  token_hash text not null unique,
  status public.commerce_access_status not null default 'active',
  expires_at timestamptz,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id, product_id)
);

create index commerce_access_product_idx
  on public.commerce_access_grants(product_id, status);

create table public.commerce_leads (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  name text,
  answers jsonb not null default '{}'::jsonb,
  source text,
  created_at timestamptz not null default now(),
  unique(product_id, email)
);

create index commerce_leads_creator_idx
  on public.commerce_leads(creator_id, created_at desc);

create table public.commerce_course_lessons (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  module_title text not null default 'Course',
  position integer not null default 0 check (position >= 0),
  title text not null,
  summary text not null default '',
  content_type text not null default 'text'
    check (content_type in ('text', 'video', 'file', 'link')),
  content jsonb not null default '{}'::jsonb,
  is_preview boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commerce_lessons_product_idx
  on public.commerce_course_lessons(product_id, position);

create table public.commerce_bookings (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.commerce_orders(id) on delete set null,
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  buyer_email text not null,
  buyer_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  status text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'completed', 'canceled', 'no_show')),
  meeting_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_bookings_time_check check (ends_at > starts_at)
);

create index commerce_bookings_creator_idx
  on public.commerce_bookings(creator_id, starts_at);

create table public.commerce_community_posts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  access_grant_id uuid references public.commerce_access_grants(id) on delete set null,
  author_kind text not null check (author_kind in ('creator', 'member')),
  author_name text not null,
  body text not null check (length(body) between 1 and 10000),
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commerce_community_posts_product_idx
  on public.commerce_community_posts(product_id, is_pinned desc, created_at desc);

create table public.commerce_community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.commerce_community_posts(id) on delete cascade,
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  access_grant_id uuid references public.commerce_access_grants(id) on delete set null,
  author_kind text not null check (author_kind in ('creator', 'member')),
  author_name text not null,
  body text not null check (length(body) between 1 and 3000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commerce_community_comments_post_idx
  on public.commerce_community_comments(post_id, created_at);

create table public.commerce_affiliate_clicks (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  visitor_hash text,
  referrer text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index commerce_affiliate_clicks_creator_idx
  on public.commerce_affiliate_clicks(creator_id, created_at desc);

create table public.creator_payment_accounts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null unique references auth.users(id) on delete cascade,
  provider text not null,
  provider_account_id text unique,
  onboarding_status text not null default 'not_started'
    check (onboarding_status in ('not_started', 'pending', 'restricted', 'complete', 'disabled')),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  country text,
  default_currency text,
  requirements jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.commerce_payout_requests (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_payout_id text unique,
  amount integer not null check (amount > 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  status text not null default 'requested'
    check (status in ('requested', 'processing', 'paid', 'failed', 'canceled')),
  failure_reason text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commerce_payout_requests_creator_idx
  on public.commerce_payout_requests(creator_id, requested_at desc);

create table public.commerce_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);

-- Public product pages are served through a server function that returns a
-- strict allowlist. Direct table reads would expose private delivery settings,
-- so even published products stay owner-only at the database boundary.
alter table public.commerce_products enable row level security;
alter table public.commerce_orders enable row level security;
alter table public.commerce_access_grants enable row level security;
alter table public.commerce_leads enable row level security;
alter table public.commerce_course_lessons enable row level security;
alter table public.commerce_bookings enable row level security;
alter table public.commerce_community_posts enable row level security;
alter table public.commerce_community_comments enable row level security;
alter table public.commerce_affiliate_clicks enable row level security;
alter table public.creator_payment_accounts enable row level security;
alter table public.commerce_payout_requests enable row level security;
alter table public.commerce_webhook_events enable row level security;

grant select on public.commerce_products to authenticated;
grant insert (
  creator_id, kind, status, slug, title, subtitle, description, cover_url,
  gallery_urls, pricing_type, price_amount, currency, billing_interval,
  cta_label, settings, inventory_limit, published_at
) on public.commerce_products to authenticated;
grant update (
  status, title, subtitle, description, cover_url, gallery_urls, pricing_type,
  price_amount, currency, billing_interval, cta_label, settings,
  inventory_limit, published_at
) on public.commerce_products to authenticated;
grant delete on public.commerce_products to authenticated;
grant select on public.commerce_orders, public.commerce_leads, public.commerce_bookings,
  public.commerce_course_lessons, public.commerce_community_posts,
  public.commerce_community_comments, public.commerce_payout_requests to authenticated;
grant insert, update, delete on public.commerce_course_lessons,
  public.commerce_community_posts, public.commerce_community_comments to authenticated;
grant all on public.commerce_products, public.commerce_orders,
  public.commerce_access_grants, public.commerce_leads, public.commerce_course_lessons,
  public.commerce_bookings, public.commerce_community_posts,
  public.commerce_community_comments, public.commerce_affiliate_clicks,
  public.creator_payment_accounts, public.commerce_payout_requests,
  public.commerce_webhook_events to service_role;

create policy commerce_products_owner_read
  on public.commerce_products for select
  to authenticated
  using (auth.uid() = creator_id);

create policy commerce_products_owner_write
  on public.commerce_products for all
  to authenticated
  using (auth.uid() = creator_id)
  with check (auth.uid() = creator_id);

create policy commerce_orders_owner_read
  on public.commerce_orders for select
  to authenticated
  using (auth.uid() = creator_id);

create policy commerce_leads_owner_read
  on public.commerce_leads for select
  to authenticated
  using (auth.uid() = creator_id);

create policy commerce_bookings_owner_read
  on public.commerce_bookings for select
  to authenticated
  using (auth.uid() = creator_id);

create policy commerce_lessons_owner_all
  on public.commerce_course_lessons for all
  to authenticated
  using (
    auth.uid() = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_course_lessons.product_id
        and product.creator_id = auth.uid()
    )
  )
  with check (
    auth.uid() = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_course_lessons.product_id
        and product.creator_id = auth.uid()
    )
  );

create policy commerce_posts_owner_all
  on public.commerce_community_posts for all
  to authenticated
  using (
    auth.uid() = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_posts.product_id
        and product.creator_id = auth.uid()
    )
  )
  with check (
    auth.uid() = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_posts.product_id
        and product.creator_id = auth.uid()
    )
  );

create policy commerce_comments_owner_all
  on public.commerce_community_comments for all
  to authenticated
  using (
    auth.uid() = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_comments.product_id
        and product.creator_id = auth.uid()
    )
  )
  with check (
    auth.uid() = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_comments.product_id
        and product.creator_id = auth.uid()
    )
    and exists (
      select 1 from public.commerce_community_posts post
      where post.id = commerce_community_comments.post_id
        and post.product_id = commerce_community_comments.product_id
    )
  );

create policy commerce_payouts_owner_read
  on public.commerce_payout_requests for select
  to authenticated
  using (auth.uid() = creator_id);

create trigger commerce_products_updated_at
  before update on public.commerce_products
  for each row execute function public.tg_set_updated_at();
create trigger commerce_orders_updated_at
  before update on public.commerce_orders
  for each row execute function public.tg_set_updated_at();
create trigger commerce_access_updated_at
  before update on public.commerce_access_grants
  for each row execute function public.tg_set_updated_at();
create trigger commerce_lessons_updated_at
  before update on public.commerce_course_lessons
  for each row execute function public.tg_set_updated_at();
create trigger commerce_bookings_updated_at
  before update on public.commerce_bookings
  for each row execute function public.tg_set_updated_at();
create trigger commerce_posts_updated_at
  before update on public.commerce_community_posts
  for each row execute function public.tg_set_updated_at();
create trigger commerce_comments_updated_at
  before update on public.commerce_community_comments
  for each row execute function public.tg_set_updated_at();
create trigger creator_payment_accounts_updated_at
  before update on public.creator_payment_accounts
  for each row execute function public.tg_set_updated_at();
create trigger commerce_payout_requests_updated_at
  before update on public.commerce_payout_requests
  for each row execute function public.tg_set_updated_at();
create trigger commerce_webhook_events_updated_at
  before update on public.commerce_webhook_events
  for each row execute function public.tg_set_updated_at();
