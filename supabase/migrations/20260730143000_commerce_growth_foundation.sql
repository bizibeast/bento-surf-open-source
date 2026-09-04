-- Creator growth foundation: discounts, order bumps, consented lists, campaigns,
-- and immutable checkout line-item attribution.
--
-- Rollback: drop the triggers/functions below, then the new tables. The added
-- payment-session and Audience columns are nullable/additive and can remain.

create table public.commerce_discount_codes (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid references public.commerce_products(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value integer not null check (discount_value > 0),
  currency text check (currency is null or currency ~ '^[a-z]{3}$'),
  starts_at timestamptz,
  expires_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  max_redemptions_per_email integer not null default 1
    check (max_redemptions_per_email between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_discount_codes_creator_code_unique unique (creator_id, code),
  constraint commerce_discount_codes_window_check
    check (expires_at is null or starts_at is null or expires_at > starts_at),
  constraint commerce_discount_codes_value_check check (
    (discount_type = 'percent' and discount_value between 1 and 10000 and currency is null)
    or
    (discount_type = 'fixed' and discount_value > 0 and currency is not null)
  )
);

create index commerce_discount_codes_creator_active_idx
  on public.commerce_discount_codes(creator_id, is_active, created_at desc);
create index commerce_discount_codes_product_idx
  on public.commerce_discount_codes(product_id) where product_id is not null;

create table public.commerce_order_bumps (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  primary_product_id uuid not null references public.commerce_products(id) on delete cascade,
  bump_product_id uuid not null references public.commerce_products(id) on delete cascade,
  headline text not null default 'Add this to my order'
    check (length(trim(headline)) between 1 and 120),
  description text not null default '' check (length(description) <= 500),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_order_bumps_pair_unique unique (primary_product_id, bump_product_id),
  constraint commerce_order_bumps_distinct_products check (primary_product_id <> bump_product_id)
);

create index commerce_order_bumps_creator_idx
  on public.commerce_order_bumps(creator_id, is_active, created_at desc);

alter table public.commerce_payment_sessions
  add column if not exists subtotal_amount integer check (subtotal_amount is null or subtotal_amount >= 0),
  add column if not exists discount_amount integer not null default 0 check (discount_amount >= 0),
  add column if not exists discount_code_id uuid references public.commerce_discount_codes(id) on delete set null,
  add column if not exists bump_product_id uuid references public.commerce_products(id) on delete set null,
  add column if not exists bump_amount integer not null default 0 check (bump_amount >= 0),
  add column if not exists attribution jsonb not null default '{}'::jsonb;

create table public.commerce_discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  discount_code_id uuid not null references public.commerce_discount_codes(id) on delete restrict,
  creator_id uuid not null references auth.users(id) on delete cascade,
  payment_session_id uuid not null unique
    references public.commerce_payment_sessions(id) on delete cascade,
  order_id uuid unique references public.commerce_orders(id) on delete set null,
  buyer_email_normalized text not null check (length(buyer_email_normalized) between 3 and 254),
  discount_amount integer not null check (discount_amount > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'redeemed', 'released')),
  reserved_until timestamptz not null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commerce_discount_redemptions_code_status_idx
  on public.commerce_discount_redemptions(discount_code_id, status, reserved_until);
create index commerce_discount_redemptions_email_idx
  on public.commerce_discount_redemptions(
    discount_code_id, buyer_email_normalized, status
  );
create index commerce_discount_redemptions_creator_idx
  on public.commerce_discount_redemptions(creator_id, created_at desc);

create table public.commerce_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  product_id uuid references public.commerce_products(id) on delete set null,
  item_role text not null check (item_role in ('primary', 'bump', 'recording_addon')),
  title text not null check (length(trim(title)) between 1 and 180),
  quantity integer not null default 1 check (quantity > 0),
  unit_amount integer not null check (unit_amount >= 0),
  total_amount integer not null check (total_amount >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint commerce_order_items_order_role_product_unique
    unique nulls not distinct (order_id, item_role, product_id)
);

create index commerce_order_items_order_idx on public.commerce_order_items(order_id);
create index commerce_order_items_product_idx on public.commerce_order_items(product_id);

alter table public.audience_contacts
  add column if not exists marketing_status text not null default 'unknown'
    check (marketing_status in ('unknown', 'subscribed', 'unsubscribed')),
  add column if not exists marketing_consented_at timestamptz,
  add column if not exists marketing_unsubscribed_at timestamptz;

create table public.audience_consent_events (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  status text not null check (status in ('subscribed', 'unsubscribed')),
  source text not null check (length(trim(source)) between 1 and 80),
  proof jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index audience_consent_events_contact_idx
  on public.audience_consent_events(contact_id, occurred_at desc);
create index audience_consent_events_creator_idx
  on public.audience_consent_events(creator_id, occurred_at desc);

create table public.audience_lists (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audience_lists_creator_name_unique unique (creator_id, name)
);

create table public.audience_list_members (
  list_id uuid not null references public.audience_lists(id) on delete cascade,
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, contact_id)
);

create index audience_list_members_contact_idx
  on public.audience_list_members(contact_id);

create table public.audience_campaigns (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  list_id uuid references public.audience_lists(id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 120),
  subject text not null check (length(trim(subject)) between 1 and 180),
  preview_text text not null default '' check (length(preview_text) <= 240),
  body_markdown text not null check (length(body_markdown) between 1 and 50000),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'canceled')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index audience_campaigns_creator_idx
  on public.audience_campaigns(creator_id, created_at desc);

create table public.audience_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.audience_campaigns(id) on delete cascade,
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  email_outbox_id uuid references public.email_outbox(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'sent', 'failed', 'skipped')),
  skip_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audience_campaign_recipients_unique unique (campaign_id, contact_id)
);

create index audience_campaign_recipients_campaign_idx
  on public.audience_campaign_recipients(campaign_id, status);

alter table public.commerce_discount_codes enable row level security;
alter table public.commerce_order_bumps enable row level security;
alter table public.commerce_discount_redemptions enable row level security;
alter table public.commerce_order_items enable row level security;
alter table public.audience_consent_events enable row level security;
alter table public.audience_lists enable row level security;
alter table public.audience_list_members enable row level security;
alter table public.audience_campaigns enable row level security;
alter table public.audience_campaign_recipients enable row level security;

create policy commerce_discount_codes_owner_all on public.commerce_discount_codes
  for all to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);
create policy commerce_order_bumps_owner_all on public.commerce_order_bumps
  for all to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);
create policy commerce_discount_redemptions_owner_read on public.commerce_discount_redemptions
  for select to authenticated using ((select auth.uid()) = creator_id);
create policy commerce_order_items_owner_read on public.commerce_order_items
  for select to authenticated using (
    exists (
      select 1 from public.commerce_orders orders
      where orders.id = order_id and orders.creator_id = (select auth.uid())
    )
  );
create policy audience_consent_events_owner_read on public.audience_consent_events
  for select to authenticated using ((select auth.uid()) = creator_id);
create policy audience_lists_owner_all on public.audience_lists
  for all to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);
create policy audience_list_members_owner_all on public.audience_list_members
  for all to authenticated
  using (
    exists (
      select 1 from public.audience_lists lists
      where lists.id = list_id and lists.creator_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.audience_lists lists
      join public.audience_contacts contacts on contacts.id = contact_id
      where lists.id = list_id
        and lists.creator_id = (select auth.uid())
        and contacts.creator_id = (select auth.uid())
    )
  );
create policy audience_campaigns_owner_all on public.audience_campaigns
  for all to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);
create policy audience_campaign_recipients_owner_read on public.audience_campaign_recipients
  for select to authenticated using (
    exists (
      select 1 from public.audience_campaigns campaigns
      where campaigns.id = campaign_id and campaigns.creator_id = (select auth.uid())
    )
  );

-- Growth mutations must pass through the authenticated server functions, which
-- enforce Store-plan entitlements. Do not grant browser writes here: an owner
-- RLS policy alone would protect tenancy but would still let a signed-in user
-- bypass plan checks by calling the Data API directly.
revoke all on public.commerce_discount_codes, public.commerce_order_bumps,
  public.commerce_discount_redemptions, public.commerce_order_items,
  public.audience_consent_events, public.audience_lists, public.audience_list_members,
  public.audience_campaigns, public.audience_campaign_recipients
  from anon, authenticated;
grant all on public.commerce_discount_codes, public.commerce_order_bumps,
  public.commerce_discount_redemptions, public.commerce_order_items,
  public.audience_consent_events, public.audience_lists, public.audience_list_members,
  public.audience_campaigns, public.audience_campaign_recipients to service_role;

create trigger commerce_discount_codes_updated_at before update on public.commerce_discount_codes
  for each row execute function public.tg_set_updated_at();
create trigger commerce_order_bumps_updated_at before update on public.commerce_order_bumps
  for each row execute function public.tg_set_updated_at();
create trigger commerce_discount_redemptions_updated_at
  before update on public.commerce_discount_redemptions
  for each row execute function public.tg_set_updated_at();
create trigger audience_lists_updated_at before update on public.audience_lists
  for each row execute function public.tg_set_updated_at();
create trigger audience_campaigns_updated_at before update on public.audience_campaigns
  for each row execute function public.tg_set_updated_at();
create trigger audience_campaign_recipients_updated_at
  before update on public.audience_campaign_recipients
  for each row execute function public.tg_set_updated_at();

create or replace function public.commerce_validate_growth_relationships()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  primary_row public.commerce_products%rowtype;
  bump_row public.commerce_products%rowtype;
begin
  if tg_table_name = 'commerce_discount_codes' and new.product_id is not null then
    select * into primary_row from public.commerce_products where id = new.product_id;
    if primary_row.id is null or primary_row.creator_id <> new.creator_id then
      raise exception 'Discount product must belong to the creator';
    end if;
    if new.discount_type = 'fixed' and new.currency <> primary_row.currency then
      raise exception 'Fixed discount currency must match the product';
    end if;
  elsif tg_table_name = 'commerce_order_bumps' then
    select * into primary_row from public.commerce_products where id = new.primary_product_id;
    select * into bump_row from public.commerce_products where id = new.bump_product_id;
    if primary_row.id is null or bump_row.id is null
      or primary_row.creator_id <> new.creator_id
      or bump_row.creator_id <> new.creator_id then
      raise exception 'Order bump products must belong to the creator';
    end if;
    if primary_row.currency <> bump_row.currency then
      raise exception 'Order bump products must use the same currency';
    end if;
    if bump_row.pricing_type <> 'one_time' then
      raise exception 'Order bump must be a one-time product';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.commerce_validate_growth_relationships()
  from public, anon, authenticated;

create trigger commerce_discount_codes_relationships
  before insert or update on public.commerce_discount_codes
  for each row execute function public.commerce_validate_growth_relationships();
create trigger commerce_order_bumps_relationships
  before insert or update on public.commerce_order_bumps
  for each row execute function public.commerce_validate_growth_relationships();

create or replace function public.commerce_apply_audience_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.audience_contacts
  set marketing_consent = new.status = 'subscribed',
      marketing_status = new.status,
      marketing_consented_at = case
        when new.status = 'subscribed' then new.occurred_at
        else marketing_consented_at
      end,
      marketing_unsubscribed_at = case
        when new.status = 'unsubscribed' then new.occurred_at
        else null
      end,
      updated_at = now()
  where id = new.contact_id and creator_id = new.creator_id;
  if not found then raise exception 'Audience contact does not belong to creator'; end if;
  return new;
end;
$$;

revoke all on function public.commerce_apply_audience_consent()
  from public, anon, authenticated;
create trigger audience_consent_events_apply
  after insert on public.audience_consent_events
  for each row execute function public.commerce_apply_audience_consent();

create or replace function public.reserve_commerce_discount(
  p_discount_code_id uuid,
  p_payment_session_id uuid,
  p_buyer_email text,
  p_discount_amount integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  code_row public.commerce_discount_codes%rowtype;
  session_row public.commerce_payment_sessions%rowtype;
  active_total integer;
  email_total integer;
begin
  select * into session_row from public.commerce_payment_sessions
  where id = p_payment_session_id and status = 'pending' for update;
  if session_row.id is null then raise exception 'Checkout session is not pending'; end if;

  select * into code_row from public.commerce_discount_codes
  where id = p_discount_code_id for update;
  if code_row.id is null or code_row.creator_id <> session_row.creator_id
    or not code_row.is_active
    or (code_row.product_id is not null and code_row.product_id <> session_row.product_id)
    or (code_row.starts_at is not null and code_row.starts_at > now())
    or (code_row.expires_at is not null and code_row.expires_at <= now()) then
    raise exception 'Discount code is not available';
  end if;

  update public.commerce_discount_redemptions
  set status = 'released'
  where discount_code_id = code_row.id
    and status = 'reserved' and reserved_until <= now();

  select count(*) into active_total from public.commerce_discount_redemptions
  where discount_code_id = code_row.id and status in ('reserved', 'redeemed');
  select count(*) into email_total from public.commerce_discount_redemptions
  where discount_code_id = code_row.id
    and buyer_email_normalized = lower(trim(p_buyer_email))
    and status in ('reserved', 'redeemed');

  if code_row.max_redemptions is not null and active_total >= code_row.max_redemptions then
    raise exception 'Discount code redemption limit reached';
  end if;
  if email_total >= code_row.max_redemptions_per_email then
    raise exception 'Discount code already used by this email';
  end if;

  insert into public.commerce_discount_redemptions(
    discount_code_id, creator_id, payment_session_id, buyer_email_normalized,
    discount_amount, reserved_until
  ) values (
    code_row.id, code_row.creator_id, session_row.id, lower(trim(p_buyer_email)),
    p_discount_amount, least(session_row.expires_at, now() + interval '2 hours')
  );
end;
$$;

revoke all on function public.reserve_commerce_discount(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_commerce_discount(uuid, uuid, text, integer)
  to service_role;

create or replace function public.commerce_finalize_growth_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.commerce_payment_sessions%rowtype;
  product_row public.commerce_products%rowtype;
  bump_row public.commerce_products%rowtype;
begin
  select * into session_row
  from public.commerce_payment_sessions
  where creator_id = new.creator_id
    and product_id = new.product_id
    and (
      provider_checkout_id = new.provider_checkout_id
      or id::text = new.provider_checkout_id
      or id::text = new.metadata->>'bento_session_id'
    )
  order by created_at desc limit 1;

  select * into product_row from public.commerce_products where id = new.product_id;
  insert into public.commerce_order_items(
    order_id, product_id, item_role, title, unit_amount, total_amount, currency, metadata
  ) values (
    new.id, new.product_id, 'primary', product_row.title,
    greatest(0, coalesce(session_row.subtotal_amount, new.gross_amount)
      - coalesce(session_row.bump_amount, 0)
      - coalesce(session_row.recording_addon_amount, 0)),
    greatest(0, coalesce(session_row.subtotal_amount, new.gross_amount)
      - coalesce(session_row.bump_amount, 0)
      - coalesce(session_row.recording_addon_amount, 0)
      - coalesce(session_row.discount_amount, 0)),
    new.currency,
    jsonb_build_object('discount_amount', coalesce(session_row.discount_amount, 0))
  ) on conflict do nothing;

  if session_row.recording_addon_selected
    and coalesce(session_row.recording_addon_amount, 0) > 0 then
    insert into public.commerce_order_items(
      order_id, product_id, item_role, title, unit_amount, total_amount, currency
    ) values (
      new.id, null, 'recording_addon', product_row.title || ' recording',
      session_row.recording_addon_amount, session_row.recording_addon_amount, new.currency
    ) on conflict do nothing;
  end if;

  if session_row.bump_product_id is not null and session_row.bump_amount > 0 then
    select * into bump_row from public.commerce_products where id = session_row.bump_product_id;
    if bump_row.id is not null then
      insert into public.commerce_order_items(
        order_id, product_id, item_role, title, unit_amount, total_amount, currency
      ) values (
        new.id, bump_row.id, 'bump', bump_row.title,
        session_row.bump_amount, session_row.bump_amount, new.currency
      ) on conflict do nothing;

      insert into public.commerce_access_grants(
        order_id, product_id, creator_id, buyer_email, token_hash, source
      ) values (
        new.id, bump_row.id, new.creator_id, lower(new.buyer_email),
        encode(extensions.digest(
          convert_to(new.id::text || ':' || bump_row.id::text || ':bump', 'UTF8'), 'sha256'
        ), 'hex'),
        'purchase'
      ) on conflict (order_id, product_id) do nothing;
    end if;
  end if;

  if session_row.discount_code_id is not null then
    update public.commerce_discount_redemptions
    set status = 'redeemed', order_id = new.id, redeemed_at = coalesce(new.paid_at, now())
    where payment_session_id = session_row.id and status = 'reserved';
  end if;

  update public.commerce_orders
  set attribution = coalesce(attribution, '{}'::jsonb)
      || coalesce(session_row.attribution, '{}'::jsonb)
      || jsonb_build_object(
        'discount_code_id', session_row.discount_code_id,
        'discount_amount', coalesce(session_row.discount_amount, 0),
        'bump_product_id', session_row.bump_product_id,
        'bump_amount', coalesce(session_row.bump_amount, 0)
      )
  where id = new.id;
  return new;
end;
$$;

revoke all on function public.commerce_finalize_growth_attribution()
  from public, anon, authenticated;
create trigger commerce_orders_finalize_growth_attribution
  after insert on public.commerce_orders
  for each row execute function public.commerce_finalize_growth_attribution();
