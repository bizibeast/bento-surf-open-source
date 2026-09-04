-- Community managers can invite members without creating fake commerce
-- orders. Paid grants keep their order relationship and full purchase history.
alter table public.commerce_access_grants
  alter column order_id drop not null;

alter table public.commerce_access_grants
  add column if not exists member_name text,
  add column if not exists source text not null default 'purchase'
    check (source in ('purchase', 'manual'));

update public.commerce_access_grants grant_row
set
  source = case when grant_row.order_id is null then 'manual' else 'purchase' end,
  member_name = coalesce(
    grant_row.member_name,
    (
      select commerce_order.buyer_name
      from public.commerce_orders commerce_order
      where commerce_order.id = grant_row.order_id
    )
  );

create unique index if not exists commerce_access_manual_product_email_idx
  on public.commerce_access_grants(product_id, lower(buyer_email))
  where order_id is null;

create index if not exists commerce_access_creator_created_idx
  on public.commerce_access_grants(creator_id, created_at desc);

comment on column public.commerce_access_grants.source is
  'purchase for checkout fulfillment, manual for creator-issued community access';

comment on column public.commerce_access_grants.member_name is
  'Display name supplied at checkout or by the community creator';
