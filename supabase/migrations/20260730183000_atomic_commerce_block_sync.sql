-- A commerce product and every Bento card that references it are one logical
-- storefront record. Keep them synchronized inside the product transaction so
-- an interrupted second application request can never leave stale cards.
create or replace function public.sync_commerce_product_blocks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.blocks
  set
    content = jsonb_build_object(
      'productId', new.id,
      'slug', new.slug,
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
      'href', '/p/' || new.slug
    ),
    cover_url = new.cover_url
  where user_id = new.creator_id
    and type = 'commerce'
    and content->>'productId' = new.id::text;

  return new;
end;
$$;

revoke all on function public.sync_commerce_product_blocks()
  from public, anon, authenticated;

drop trigger if exists commerce_products_sync_blocks
  on public.commerce_products;
create trigger commerce_products_sync_blocks
  after update of
    slug,
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

comment on function public.sync_commerce_product_blocks() is
  'Atomically mirrors storefront-facing commerce product fields into linked Bento blocks.';
