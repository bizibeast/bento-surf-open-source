-- Keep immutable order/receipt records after a creator deletes their account,
-- while allowing all creator-owned products and private content to cascade away.
alter table public.commerce_orders
  drop constraint if exists commerce_orders_product_id_fkey;

alter table public.commerce_orders
  drop constraint if exists commerce_orders_creator_id_fkey;

alter table public.commerce_orders
  alter column product_id drop not null,
  alter column creator_id drop not null;

alter table public.commerce_orders
  add constraint commerce_orders_product_id_fkey
    foreign key (product_id) references public.commerce_products(id) on delete set null,
  add constraint commerce_orders_creator_id_fkey
    foreign key (creator_id) references auth.users(id) on delete set null;
