-- Preserve the exact digital files promised when an order is fulfilled.
--
-- Digital product settings remain editable, so resolving downloads only from
-- commerce_products.settings lets a later edit silently remove or replace a
-- buyer's purchase. Every access grant now carries a small immutable delivery
-- manifest. A trigger covers every fulfillment path (free/mock and all
-- provider webhooks) without trusting callers to remember the snapshot.

alter table public.commerce_access_grants
  add column if not exists delivery_snapshot jsonb not null default '{}'::jsonb;

comment on column public.commerce_access_grants.delivery_snapshot is
  'Immutable buyer delivery manifest captured from the product at fulfillment time.';

create or replace function public.snapshot_commerce_access_delivery()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  product_kind public.commerce_product_kind;
  product_settings jsonb;
begin
  if new.delivery_snapshot is not null and new.delivery_snapshot <> '{}'::jsonb then
    return new;
  end if;

  select product.kind, product.settings
    into product_kind, product_settings
    from public.commerce_products product
    where product.id = new.product_id
      and product.creator_id = new.creator_id;

  if product_kind = 'digital_product' then
    new.delivery_snapshot := jsonb_build_object(
      'files',
      case
        when jsonb_typeof(product_settings -> 'files') = 'array'
          then product_settings -> 'files'
        else '[]'::jsonb
      end
    );
  else
    new.delivery_snapshot := '{}'::jsonb;
  end if;

  return new;
end;
$$;

revoke all on function public.snapshot_commerce_access_delivery()
  from public, anon, authenticated;

drop trigger if exists commerce_access_grants_snapshot_delivery
  on public.commerce_access_grants;
create trigger commerce_access_grants_snapshot_delivery
  before insert on public.commerce_access_grants
  for each row execute function public.snapshot_commerce_access_delivery();

-- Existing active and historical grants are backfilled once from the current
-- product. New grants are always captured by the trigger above.
update public.commerce_access_grants grant_row
set delivery_snapshot = jsonb_build_object(
  'files',
  case
    when jsonb_typeof(product.settings -> 'files') = 'array'
      then product.settings -> 'files'
    else '[]'::jsonb
  end
)
from public.commerce_products product
where product.id = grant_row.product_id
  and product.creator_id = grant_row.creator_id
  and product.kind = 'digital_product'
  and grant_row.delivery_snapshot = '{}'::jsonb;
