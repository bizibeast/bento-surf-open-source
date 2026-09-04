-- Public creator resources are canonical beneath /@username. Keep the old
-- product slug as a stable compatibility key and add a creator-scoped slug
-- for clean public URLs.

create table if not exists public.profile_username_aliases (
  username text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint profile_username_aliases_format
    check (username ~ '^[a-z0-9_]{3,30}$')
);

create index if not exists profile_username_aliases_user_idx
  on public.profile_username_aliases(user_id);

alter table public.profile_username_aliases enable row level security;
revoke all on public.profile_username_aliases from public, anon, authenticated;
grant all on public.profile_username_aliases to service_role;

alter table public.profiles
  add column if not exists username_changed_at timestamptz;

create or replace function public.preserve_profile_username_alias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  alias_owner uuid;
begin
  if tg_op = 'UPDATE' and new.username is not distinct from old.username then
    new.username_changed_at = old.username_changed_at;
    return new;
  end if;

  delete from public.profile_username_aliases
  where username = new.username
    and expires_at <= now();

  select alias.user_id
    into alias_owner
    from public.profile_username_aliases alias
    where alias.username = new.username;

  if alias_owner is not null and alias_owner <> new.id then
    raise unique_violation using message = 'Username is reserved by an existing account.';
  end if;

  if tg_op = 'UPDATE' and new.username is distinct from old.username then
    if old.username_changed_at > now() - interval '30 days' then
      raise check_violation
        using message = 'Username can only be changed once every 30 days.';
    end if;

    delete from public.profile_username_aliases
      where username = new.username and user_id = new.id;

    insert into public.profile_username_aliases(username, user_id, expires_at)
    values (old.username, old.id, now() + interval '14 days')
    on conflict (username) do update
      set user_id = excluded.user_id,
          created_at = now(),
          expires_at = excluded.expires_at
      where profile_username_aliases.user_id = excluded.user_id;

    new.username_changed_at = now();
  end if;

  return new;
end;
$$;

revoke all on function public.preserve_profile_username_alias()
  from public, anon, authenticated;

drop trigger if exists preserve_profile_username_alias on public.profiles;
create trigger preserve_profile_username_alias
  before insert or update on public.profiles
  for each row execute function public.preserve_profile_username_alias();

alter table public.commerce_products
  add column if not exists public_slug text;

with product_roots as (
  select
    product.id,
    product.creator_id,
    product.created_at,
    case
      when length(trim(both '-' from regexp_replace(lower(product.title), '[^a-z0-9]+', '-', 'g'))) >= 3
        then left(trim(both '-' from regexp_replace(lower(product.title), '[^a-z0-9]+', '-', 'g')), 64)
      when trim(both '-' from regexp_replace(lower(product.title), '[^a-z0-9]+', '-', 'g')) <> ''
        then left(trim(both '-' from regexp_replace(lower(product.title), '[^a-z0-9]+', '-', 'g')) || '-product', 64)
      else 'product'
    end as root
  from public.commerce_products product
  where product.public_slug is null
), ranked_products as (
  select
    root.*,
    row_number() over (
      partition by root.creator_id, root.root
      order by root.created_at, root.id
    ) as occurrence
  from product_roots root
)
update public.commerce_products product
set public_slug = case
  when ranked.occurrence = 1 then ranked.root
  else left(ranked.root, 64 - length(ranked.occurrence::text) - 1) || '-' || ranked.occurrence
end
from ranked_products ranked
where product.id = ranked.id;

alter table public.commerce_products
  alter column public_slug set not null;

alter table public.commerce_products
  drop constraint if exists commerce_products_public_slug_check;
alter table public.commerce_products
  add constraint commerce_products_public_slug_check
  check (public_slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$');

create unique index if not exists commerce_products_creator_public_slug_idx
  on public.commerce_products(creator_id, public_slug);

create or replace function public.sync_commerce_product_blocks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator_username text;
begin
  select profile.username
    into creator_username
    from public.profiles profile
    where profile.id = new.creator_id;

  update public.blocks
  set
    content = jsonb_build_object(
      'productId', new.id,
      'slug', new.slug,
      'publicSlug', new.public_slug,
      'kind', new.kind,
      'title', new.title,
      'subtitle', new.subtitle,
      'coverUrl', new.cover_url,
      'pricingType', new.pricing_type,
      'priceAmount', new.price_amount,
      'currency', new.currency,
      'billingInterval', new.billing_interval,
      'ctaLabel', new.cta_label,
      'status', new.status,
      'href', '/@' || creator_username || '/products/' || new.public_slug
    ),
    cover_url = new.cover_url
  where user_id = new.creator_id
    and type = 'commerce'
    and content->>'productId' = new.id::text;

  return new;
end;
$$;

drop trigger if exists commerce_products_sync_blocks
  on public.commerce_products;
create trigger commerce_products_sync_blocks
  after update of
    slug,
    public_slug,
    kind,
    title,
    subtitle,
    cover_url,
    pricing_type,
    price_amount,
    currency,
    billing_interval,
    cta_label,
    status
  on public.commerce_products
  for each row execute function public.sync_commerce_product_blocks();

update public.blocks block
set content = block.content || jsonb_build_object(
  'publicSlug', product.public_slug,
  'href', '/@' || profile.username || '/products/' || product.public_slug
)
from public.commerce_products product
join public.profiles profile on profile.id = product.creator_id
where block.user_id = product.creator_id
  and block.type = 'commerce'
  and block.content->>'productId' = product.id::text;

-- System slugs remain available to existing pages, but all future page slugs
-- are routed away from reserved creator resource names by application code.
comment on column public.commerce_products.public_slug is
  'Creator-scoped slug used by /@username/products/:publicSlug.';
