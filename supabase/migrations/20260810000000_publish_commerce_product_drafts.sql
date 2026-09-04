-- Draft is no longer a creator-facing Store product state.
-- The existing product-block sync trigger mirrors this status change to linked blocks.
update public.commerce_products
set
  status = 'published',
  published_at = coalesce(published_at, now())
where status = 'draft';
