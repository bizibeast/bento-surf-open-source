-- Creator commerce foundation: durable customer identity and unified Audience.
--
-- This migration is intentionally additive. Existing commerce_leads,
-- commerce_orders, commerce_bookings, and commerce_access_grants remain the
-- operational source tables while contacts and append-only events provide the
-- unified creator-facing customer view.

create table public.commerce_customers (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(trim(email)) between 3 and 254),
  email_normalized text generated always as (lower(trim(email))) stored,
  name text check (name is null or length(name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_customers_email_unique unique (email_normalized)
);

create table public.audience_contacts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid not null references public.commerce_customers(id) on delete restrict,
  email text not null check (length(trim(email)) between 3 and 254),
  email_normalized text generated always as (lower(trim(email))) stored,
  name text check (name is null or length(name) <= 120),
  marketing_consent boolean not null default false,
  first_source text not null default 'unknown' check (length(first_source) between 1 and 60),
  last_source text not null default 'unknown' check (length(last_source) between 1 and 60),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audience_contacts_creator_email_unique unique (creator_id, email_normalized),
  constraint audience_contacts_creator_customer_unique unique (creator_id, customer_id)
);

create index audience_contacts_creator_last_seen_idx
  on public.audience_contacts(creator_id, last_seen_at desc);

create table public.audience_events (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  event_type text not null check (length(event_type) between 1 and 80),
  source_type text not null check (length(source_type) between 1 and 60),
  source_id uuid,
  product_id uuid references public.commerce_products(id) on delete set null,
  order_id uuid references public.commerce_orders(id) on delete set null,
  booking_id uuid references public.commerce_bookings(id) on delete set null,
  amount integer check (amount is null or amount >= 0),
  currency text check (currency is null or currency ~ '^[a-z]{3}$'),
  dedupe_key text not null check (length(dedupe_key) between 3 and 240),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint audience_events_creator_dedupe_unique unique (creator_id, dedupe_key)
);

create index audience_events_contact_occurred_idx
  on public.audience_events(contact_id, occurred_at desc);
create index audience_events_creator_occurred_idx
  on public.audience_events(creator_id, occurred_at desc);
create index audience_events_creator_type_idx
  on public.audience_events(creator_id, event_type, occurred_at desc);

-- Customer authentication is intentionally service-role only. Tokens are
-- represented exclusively by hashes and never stored in plaintext.
create table public.commerce_customer_magic_links (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.commerce_customers(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  purpose text not null default 'library_login'
    check (purpose in ('library_login', 'claim_access')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index commerce_customer_magic_links_active_idx
  on public.commerce_customer_magic_links(token_hash, expires_at)
  where used_at is null;

create table public.commerce_customer_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.commerce_customers(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index commerce_customer_sessions_active_idx
  on public.commerce_customer_sessions(token_hash, expires_at)
  where revoked_at is null;

-- The helper has no public execution path. It is called only from row triggers
-- on existing commerce source tables and performs normalized, idempotent
-- customer/contact upserts.
create or replace function public.commerce_upsert_audience_contact(
  p_creator_id uuid,
  p_email text,
  p_name text,
  p_source text,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  customer_row_id uuid;
  contact_row_id uuid;
  normalized_email text := lower(trim(p_email));
  clean_source text := left(coalesce(nullif(trim(p_source), ''), 'unknown'), 60);
  event_time timestamptz := coalesce(p_occurred_at, now());
begin
  if p_creator_id is null or normalized_email = '' or length(normalized_email) > 254 then
    raise exception 'A valid creator and email are required';
  end if;

  insert into public.commerce_customers(email, name)
  values (normalized_email, nullif(left(trim(coalesce(p_name, '')), 120), ''))
  on conflict (email_normalized) do update
    set name = coalesce(nullif(excluded.name, ''), commerce_customers.name),
        updated_at = now()
  returning id into customer_row_id;

  insert into public.audience_contacts(
    creator_id,
    customer_id,
    email,
    name,
    first_source,
    last_source,
    first_seen_at,
    last_seen_at
  )
  values (
    p_creator_id,
    customer_row_id,
    normalized_email,
    nullif(left(trim(coalesce(p_name, '')), 120), ''),
    clean_source,
    clean_source,
    event_time,
    event_time
  )
  on conflict (creator_id, email_normalized) do update
    set customer_id = excluded.customer_id,
        name = coalesce(nullif(excluded.name, ''), audience_contacts.name),
        last_source = case
          when excluded.last_seen_at >= audience_contacts.last_seen_at
            then excluded.last_source
          else audience_contacts.last_source
        end,
        first_seen_at = least(audience_contacts.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(audience_contacts.last_seen_at, excluded.last_seen_at),
        updated_at = now()
  returning id into contact_row_id;

  return contact_row_id;
end;
$$;

revoke all on function public.commerce_upsert_audience_contact(
  uuid, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.commerce_upsert_audience_contact(
  uuid, text, text, text, timestamptz
) to service_role;

create or replace function public.commerce_sync_lead_to_audience()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_row_id uuid;
begin
  if new.creator_id is null or new.email is null or trim(new.email) = '' then
    return new;
  end if;
  contact_row_id := public.commerce_upsert_audience_contact(
    new.creator_id, new.email, new.name, 'lead_form', new.created_at
  );
  insert into public.audience_events(
    creator_id, contact_id, event_type, source_type, source_id, product_id,
    dedupe_key, metadata, occurred_at
  )
  values (
    new.creator_id, contact_row_id, 'lead_submitted', 'commerce_lead', new.id,
    new.product_id, 'lead:' || new.id::text,
    jsonb_build_object('answers', new.answers, 'source', new.source),
    new.created_at
  )
  on conflict (creator_id, dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function public.commerce_sync_order_to_audience()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_row_id uuid;
begin
  if new.creator_id is null or new.buyer_email is null or trim(new.buyer_email) = '' then
    return new;
  end if;
  contact_row_id := public.commerce_upsert_audience_contact(
    new.creator_id, new.buyer_email, new.buyer_name, 'order', new.updated_at
  );
  insert into public.audience_events(
    creator_id, contact_id, event_type, source_type, source_id, product_id,
    order_id, amount, currency, dedupe_key, metadata, occurred_at
  )
  values (
    new.creator_id, contact_row_id, 'order_' || new.status::text, 'commerce_order',
    new.id, new.product_id, new.id, new.gross_amount, new.currency,
    'order:' || new.id::text || ':' || new.status::text,
    jsonb_build_object('provider', new.provider, 'attribution', new.attribution),
    coalesce(new.paid_at, new.updated_at, new.created_at)
  )
  on conflict (creator_id, dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function public.commerce_sync_booking_to_audience()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_row_id uuid;
begin
  if new.creator_id is null or new.buyer_email is null or trim(new.buyer_email) = '' then
    return new;
  end if;
  contact_row_id := public.commerce_upsert_audience_contact(
    new.creator_id, new.buyer_email, new.buyer_name, 'booking', new.updated_at
  );
  insert into public.audience_events(
    creator_id, contact_id, event_type, source_type, source_id, product_id,
    order_id, booking_id, dedupe_key, metadata, occurred_at
  )
  values (
    new.creator_id, contact_row_id, 'booking_' || new.status, 'commerce_booking',
    new.id, new.product_id, new.order_id, new.id,
    'booking:' || new.id::text || ':' || new.status,
    jsonb_build_object(
      'starts_at', new.starts_at,
      'ends_at', new.ends_at,
      'timezone', new.timezone
    ),
    coalesce(new.updated_at, new.created_at)
  )
  on conflict (creator_id, dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function public.commerce_sync_grant_to_audience()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_row_id uuid;
  order_name text;
begin
  if new.creator_id is null or new.buyer_email is null or trim(new.buyer_email) = '' then
    return new;
  end if;
  select buyer_name into order_name
  from public.commerce_orders
  where id = new.order_id;

  contact_row_id := public.commerce_upsert_audience_contact(
    new.creator_id,
    new.buyer_email,
    coalesce(new.member_name, order_name),
    'access',
    new.updated_at
  );
  insert into public.audience_events(
    creator_id, contact_id, event_type, source_type, source_id, product_id,
    order_id, dedupe_key, metadata, occurred_at
  )
  values (
    new.creator_id, contact_row_id, 'access_' || new.status::text,
    'commerce_access_grant', new.id, new.product_id, new.order_id,
    'access:' || new.id::text || ':' || new.status::text,
    jsonb_build_object('source', new.source, 'expires_at', new.expires_at),
    coalesce(new.updated_at, new.created_at)
  )
  on conflict (creator_id, dedupe_key) do nothing;
  return new;
end;
$$;

revoke all on function public.commerce_sync_lead_to_audience() from public, anon, authenticated;
revoke all on function public.commerce_sync_order_to_audience() from public, anon, authenticated;
revoke all on function public.commerce_sync_booking_to_audience() from public, anon, authenticated;
revoke all on function public.commerce_sync_grant_to_audience() from public, anon, authenticated;

create trigger commerce_leads_sync_audience
  after insert on public.commerce_leads
  for each row execute function public.commerce_sync_lead_to_audience();

create trigger commerce_orders_sync_audience
  after insert or update of status on public.commerce_orders
  for each row execute function public.commerce_sync_order_to_audience();

create trigger commerce_bookings_sync_audience
  after insert or update of status on public.commerce_bookings
  for each row execute function public.commerce_sync_booking_to_audience();

create trigger commerce_access_grants_sync_audience
  after insert or update of status on public.commerce_access_grants
  for each row execute function public.commerce_sync_grant_to_audience();

-- Backfill through the same trigger functions so deployment and ongoing writes
-- share identical normalization and event semantics.
insert into public.commerce_customers(email, name, created_at, updated_at)
select source.email, source.name, source.occurred_at, source.occurred_at
from (
  select distinct on (lower(trim(email)))
    lower(trim(email)) as email,
    nullif(trim(name), '') as name,
    occurred_at
  from (
    select email, name, created_at as occurred_at from public.commerce_leads
    union all
    select buyer_email, buyer_name, created_at from public.commerce_orders
    union all
    select buyer_email, buyer_name, created_at from public.commerce_bookings
  ) customer_sources
  where email is not null and trim(email) <> ''
  order by lower(trim(email)), (name is not null and trim(name) <> '') desc, occurred_at desc
) source
on conflict (email_normalized) do update
  set name = coalesce(nullif(excluded.name, ''), commerce_customers.name),
      updated_at = greatest(commerce_customers.updated_at, excluded.updated_at);

insert into public.audience_contacts(
  creator_id, customer_id, email, name, first_source, last_source,
  first_seen_at, last_seen_at
)
select
  grouped.creator_id,
  customer.id,
  grouped.email,
  grouped.name,
  grouped.first_source,
  grouped.last_source,
  grouped.first_seen_at,
  grouped.last_seen_at
from (
  select
    creator_id,
    lower(trim(email)) as email,
    (array_agg(nullif(trim(name), '') order by occurred_at desc)
      filter (where name is not null and trim(name) <> ''))[1] as name,
    (array_agg(source order by occurred_at asc))[1] as first_source,
    (array_agg(source order by occurred_at desc))[1] as last_source,
    min(occurred_at) as first_seen_at,
    max(occurred_at) as last_seen_at
  from (
    select creator_id, email, name, 'lead_form'::text as source, created_at as occurred_at
      from public.commerce_leads
    union all
    select creator_id, buyer_email, buyer_name, 'order', created_at
      from public.commerce_orders
    union all
    select creator_id, buyer_email, buyer_name, 'booking', created_at
      from public.commerce_bookings
    union all
    select grant_row.creator_id, grant_row.buyer_email,
      coalesce(grant_row.member_name, order_row.buyer_name), 'access', grant_row.created_at
      from public.commerce_access_grants grant_row
      left join public.commerce_orders order_row on order_row.id = grant_row.order_id
  ) contact_sources
  where creator_id is not null
    and email is not null
    and trim(email) <> ''
  group by creator_id, lower(trim(email))
) grouped
join public.commerce_customers customer
  on customer.email_normalized = grouped.email
on conflict (creator_id, email_normalized) do update
  set customer_id = excluded.customer_id,
      name = coalesce(nullif(excluded.name, ''), audience_contacts.name),
      first_seen_at = least(audience_contacts.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(audience_contacts.last_seen_at, excluded.last_seen_at),
      first_source = excluded.first_source,
      last_source = excluded.last_source,
      updated_at = now();

insert into public.audience_events(
  creator_id, contact_id, event_type, source_type, source_id, product_id,
  dedupe_key, metadata, occurred_at
)
select
  lead.creator_id, contact.id, 'lead_submitted', 'commerce_lead', lead.id,
  lead.product_id, 'lead:' || lead.id::text,
  jsonb_build_object('answers', lead.answers, 'source', lead.source),
  lead.created_at
from public.commerce_leads lead
join public.audience_contacts contact
  on contact.creator_id = lead.creator_id
 and contact.email_normalized = lower(trim(lead.email))
on conflict (creator_id, dedupe_key) do nothing;

insert into public.audience_events(
  creator_id, contact_id, event_type, source_type, source_id, product_id,
  order_id, amount, currency, dedupe_key, metadata, occurred_at
)
select
  commerce_order.creator_id, contact.id, 'order_' || commerce_order.status::text,
  'commerce_order', commerce_order.id, commerce_order.product_id,
  commerce_order.id, commerce_order.gross_amount, commerce_order.currency,
  'order:' || commerce_order.id::text || ':' || commerce_order.status::text,
  jsonb_build_object(
    'provider', commerce_order.provider,
    'attribution', commerce_order.attribution
  ),
  coalesce(commerce_order.paid_at, commerce_order.updated_at, commerce_order.created_at)
from public.commerce_orders commerce_order
join public.audience_contacts contact
  on contact.creator_id = commerce_order.creator_id
 and contact.email_normalized = lower(trim(commerce_order.buyer_email))
on conflict (creator_id, dedupe_key) do nothing;

insert into public.audience_events(
  creator_id, contact_id, event_type, source_type, source_id, product_id,
  order_id, booking_id, dedupe_key, metadata, occurred_at
)
select
  booking.creator_id, contact.id, 'booking_' || booking.status,
  'commerce_booking', booking.id, booking.product_id, booking.order_id, booking.id,
  'booking:' || booking.id::text || ':' || booking.status,
  jsonb_build_object(
    'starts_at', booking.starts_at,
    'ends_at', booking.ends_at,
    'timezone', booking.timezone
  ),
  coalesce(booking.updated_at, booking.created_at)
from public.commerce_bookings booking
join public.audience_contacts contact
  on contact.creator_id = booking.creator_id
 and contact.email_normalized = lower(trim(booking.buyer_email))
on conflict (creator_id, dedupe_key) do nothing;

insert into public.audience_events(
  creator_id, contact_id, event_type, source_type, source_id, product_id,
  order_id, dedupe_key, metadata, occurred_at
)
select
  grant_row.creator_id, contact.id, 'access_' || grant_row.status::text,
  'commerce_access_grant', grant_row.id, grant_row.product_id, grant_row.order_id,
  'access:' || grant_row.id::text || ':' || grant_row.status::text,
  jsonb_build_object('source', grant_row.source, 'expires_at', grant_row.expires_at),
  coalesce(grant_row.updated_at, grant_row.created_at)
from public.commerce_access_grants grant_row
join public.audience_contacts contact
  on contact.creator_id = grant_row.creator_id
 and contact.email_normalized = lower(trim(grant_row.buyer_email))
on conflict (creator_id, dedupe_key) do nothing;

alter table public.commerce_customers enable row level security;
alter table public.audience_contacts enable row level security;
alter table public.audience_events enable row level security;
alter table public.commerce_customer_magic_links enable row level security;
alter table public.commerce_customer_sessions enable row level security;

revoke all on public.commerce_customers from anon, authenticated;
revoke all on public.commerce_customer_magic_links from anon, authenticated;
revoke all on public.commerce_customer_sessions from anon, authenticated;
revoke all on public.audience_contacts from anon, authenticated;
revoke all on public.audience_events from anon, authenticated;

grant select on public.audience_contacts, public.audience_events to authenticated;
grant all on public.commerce_customers, public.audience_contacts, public.audience_events,
  public.commerce_customer_magic_links, public.commerce_customer_sessions to service_role;

create policy audience_contacts_owner_read
  on public.audience_contacts for select
  to authenticated
  using (auth.uid() = creator_id);

create policy audience_events_owner_read
  on public.audience_events for select
  to authenticated
  using (auth.uid() = creator_id);

create trigger commerce_customers_updated_at
  before update on public.commerce_customers
  for each row execute function public.tg_set_updated_at();

create trigger audience_contacts_updated_at
  before update on public.audience_contacts
  for each row execute function public.tg_set_updated_at();

comment on table public.audience_contacts is
  'One normalized creator-to-customer relationship across leads, sales, bookings, and access.';
comment on table public.audience_events is
  'Append-only, idempotent customer lifecycle events used by the creator Audience experience.';
comment on table public.commerce_customers is
  'Global normalized customer identity for passwordless Bento library access.';
comment on table public.commerce_customer_magic_links is
  'Short-lived single-use hashed tokens for customer library authentication.';
comment on table public.commerce_customer_sessions is
  'Hashed revocable sessions for the customer library; never exposed through the Data API.';
