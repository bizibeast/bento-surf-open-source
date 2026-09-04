alter type public.commerce_product_kind add value if not exists 'newsletter';

create table public.newsletter_publications (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 120),
  slug text not null check (length(slug) between 1 and 96 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '' check (length(description) <= 1000),
  logo_url text,
  cover_url text,
  accent_color text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  sender_name text not null check (length(trim(sender_name)) between 1 and 120),
  reply_to_email text check (reply_to_email is null or length(trim(reply_to_email)) between 3 and 254),
  postal_address text not null check (length(trim(postal_address)) between 1 and 500),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  paid_product_id uuid references public.commerce_products(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint newsletter_publications_creator_unique unique (creator_id)
);

create table public.newsletter_subscriptions (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.newsletter_publications(id) on delete cascade,
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'subscribed', 'unsubscribed')),
  email_enabled boolean not null default true,
  source text not null check (length(trim(source)) between 1 and 80),
  consent_proof jsonb not null default '{}'::jsonb,
  subscribed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint newsletter_subscriptions_publication_contact_unique unique (publication_id, contact_id)
);

create index newsletter_subscriptions_contact_idx
  on public.newsletter_subscriptions(contact_id);

alter table public.audience_campaigns
  add column kind text not null default 'broadcast' check (kind in ('broadcast', 'newsletter')),
  add column publication_id uuid references public.newsletter_publications(id) on delete cascade,
  add column public_slug text,
  add column content jsonb not null default '[]'::jsonb,
  add column web_visibility text not null default 'private' check (web_visibility in ('private', 'public', 'paid')),
  add column published_at timestamptz;

alter table public.audience_campaigns
  drop constraint audience_campaigns_body_markdown_check,
  add constraint audience_campaigns_body_markdown_check check (
    (kind = 'broadcast' and length(body_markdown) between 1 and 50000)
    or (kind = 'newsletter' and length(body_markdown) <= 100000)
  );

create unique index audience_campaigns_publication_slug_unique
  on public.audience_campaigns(publication_id, public_slug)
  where kind = 'newsletter' and public_slug is not null;

create or replace function public.commerce_validate_newsletter_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  product_row public.commerce_products%rowtype;
begin
  if new.paid_product_id is null then
    return new;
  end if;

  select * into product_row
  from public.commerce_products
  where id = new.paid_product_id;

  if product_row.id is null
    or product_row.creator_id is distinct from new.creator_id
    or product_row.kind::text <> 'newsletter'
  then
    raise exception 'Invalid newsletter paid product';
  end if;

  return new;
end;
$$;

create trigger newsletter_publications_validate_product
before insert or update of creator_id, paid_product_id on public.newsletter_publications
for each row execute function public.commerce_validate_newsletter_publication();

create or replace function public.commerce_validate_newsletter_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
begin
  if new.kind = 'broadcast' then
    if new.publication_id is not null
      or new.public_slug is not null
      or new.content <> '[]'::jsonb
      or new.web_visibility <> 'private'
      or new.published_at is not null
    then
      raise exception 'Broadcast campaigns cannot use newsletter fields';
    end if;
    return new;
  end if;

  if new.publication_id is null then
    raise exception 'Newsletter campaigns require a publication';
  end if;

  select * into publication_row
  from public.newsletter_publications
  where id = new.publication_id;

  if publication_row.id is null
    or publication_row.creator_id is distinct from new.creator_id
  then
    raise exception 'Invalid newsletter publication';
  end if;

  if new.web_visibility <> 'private' and new.public_slug is null then
    raise exception 'Public newsletter issues require a slug';
  end if;

  if new.web_visibility = 'paid' and publication_row.paid_product_id is null then
    raise exception 'Paid newsletter issues require a linked product';
  end if;

  return new;
end;
$$;

create trigger audience_campaigns_validate_newsletter
before insert or update of creator_id, kind, publication_id, public_slug, content, web_visibility, published_at
on public.audience_campaigns
for each row execute function public.commerce_validate_newsletter_campaign();

create or replace function public.commerce_validate_newsletter_subscription()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
  contact_row public.audience_contacts%rowtype;
begin
  select * into publication_row
  from public.newsletter_publications
  where id = new.publication_id;

  select * into contact_row
  from public.audience_contacts
  where id = new.contact_id;

  if publication_row.id is null
    or contact_row.id is null
    or publication_row.creator_id is distinct from contact_row.creator_id
  then
    raise exception 'Invalid newsletter subscription relationship';
  end if;

  return new;
end;
$$;

create trigger newsletter_subscriptions_validate_relationship
before insert or update of publication_id, contact_id on public.newsletter_subscriptions
for each row execute function public.commerce_validate_newsletter_subscription();

alter table public.newsletter_publications enable row level security;
alter table public.newsletter_subscriptions enable row level security;

create policy newsletter_publications_owner_all on public.newsletter_publications
for all to authenticated
using ((select auth.uid()) = creator_id)
with check ((select auth.uid()) = creator_id);

create policy newsletter_subscriptions_owner_all on public.newsletter_subscriptions
for all to authenticated
using (
  exists (
    select 1 from public.newsletter_publications publications
    where publications.id = publication_id
      and publications.creator_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.newsletter_publications publications
    join public.audience_contacts contacts on contacts.id = contact_id
    where publications.id = publication_id
      and publications.creator_id = (select auth.uid())
      and contacts.creator_id = (select auth.uid())
  )
);

revoke all on public.newsletter_publications, public.newsletter_subscriptions
from anon, authenticated;
grant all on public.newsletter_publications, public.newsletter_subscriptions to service_role;

revoke all on function public.commerce_validate_newsletter_publication() from public, anon, authenticated;
revoke all on function public.commerce_validate_newsletter_campaign() from public, anon, authenticated;
revoke all on function public.commerce_validate_newsletter_subscription() from public, anon, authenticated;

create trigger newsletter_publications_updated_at
before update on public.newsletter_publications
for each row execute function public.tg_set_updated_at();

create trigger newsletter_subscriptions_updated_at
before update on public.newsletter_subscriptions
for each row execute function public.tg_set_updated_at();
