-- New creator profiles and products stay out of search until their owner opts in.
alter table public.profiles
  alter column noindex set default true;

alter table public.commerce_products
  add column if not exists noindex boolean;

-- Preserve published products while keeping existing drafts and archives out of search.
update public.commerce_products
set noindex = case when status = 'published' then false else true end
where noindex is null;

alter table public.commerce_products
  alter column noindex set default true,
  alter column noindex set not null;

comment on column public.commerce_products.noindex is
  'When true, the public product page is excluded from search metadata and creator-product sitemaps.';

grant insert (noindex) on public.commerce_products to authenticated;
grant update (noindex) on public.commerce_products to authenticated;

update public.profiles
set noindex = true
where onboarded = false;

update public.profiles as profile
set noindex = true
where profile.onboarded = true
  and profile.noindex = false
  and (
    char_length(btrim(coalesce(profile.display_name, ''))) = 0
    or not (
      char_length(btrim(coalesce(profile.bio, ''))) >= 20
      or char_length(btrim(coalesce(profile.meta_description, ''))) >= 20
      or exists (
        select 1
        from public.blocks as block
        where block.user_id = profile.id
          and block.page_id is null
      )
    )
  );

create or replace view public.sitemap_profiles
with (security_invoker = true)
as
select
  profile.id,
  profile.username,
  profile.display_name,
  profile.bio,
  profile.meta_description,
  profile.avatar_url,
  greatest(
    profile.updated_at,
    coalesce(
      (
        select max(root_block.updated_at)
        from public.blocks as root_block
        where root_block.user_id = profile.id
          and root_block.page_id is null
      ),
      profile.updated_at
    )
  ) as updated_at,
  profile.onboarded,
  profile.noindex,
  profile.plan_id,
  profile.is_pro,
  true as has_public_content
from public.profiles as profile
where profile.onboarded = true
  and profile.noindex = false
  and char_length(btrim(profile.username)) > 0
  and char_length(btrim(coalesce(profile.display_name, ''))) > 0
  and (
    char_length(btrim(coalesce(profile.bio, ''))) >= 20
    or char_length(btrim(coalesce(profile.meta_description, ''))) >= 20
    or exists (
      select 1
      from public.blocks as block
      where block.user_id = profile.id
        and block.page_id is null
    )
  );

create or replace view public.sitemap_products
with (security_invoker = true)
as
select
  product.id,
  product.creator_id,
  profile.username as creator_username,
  profile.onboarded as creator_onboarded,
  profile.noindex as creator_noindex,
  profile.plan_id as creator_plan_id,
  profile.is_pro as creator_is_pro,
  product.public_slug,
  product.title,
  product.description,
  product.kind,
  product.status,
  product.noindex,
  product.updated_at
from public.commerce_products as product
join public.profiles as profile on profile.id = product.creator_id
where product.status = 'published'
  and product.noindex = false
  and profile.onboarded = true
  and profile.noindex = false
  and char_length(btrim(profile.username)) > 0
  and char_length(btrim(product.public_slug)) > 0
  and char_length(btrim(product.title)) >= 3
  and char_length(btrim(product.description)) >= 20
  and case
    when profile.plan_id in ('creator', 'store', 'max', 'pro', 'link') then true
    when profile.plan_id = 'free' then false
    else profile.is_pro
  end;

revoke all on public.sitemap_profiles, public.sitemap_products from public, anon, authenticated;
grant select on public.sitemap_profiles, public.sitemap_products to service_role;

notify pgrst, 'reload schema';
