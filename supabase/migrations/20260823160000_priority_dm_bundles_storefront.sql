-- Creator commerce additions: paid priority messages and multi-product bundles.
alter type public.commerce_product_kind add value if not exists 'priority_dm';
alter type public.commerce_product_kind add value if not exists 'bundle';

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
        when jsonb_typeof(product_settings -> 'files') = 'array' then product_settings -> 'files'
        else '[]'::jsonb
      end
    );
  elsif product_kind::text = 'bundle' then
    new.delivery_snapshot := jsonb_build_object(
      'bundleProductIds',
      case
        when jsonb_typeof(product_settings -> 'bundledProductIds') = 'array'
          then product_settings -> 'bundledProductIds'
        else '[]'::jsonb
      end,
      'bundleFiles',
      coalesce((
        select jsonb_agg(
          jsonb_build_object('productId', child.id::text, 'file', file.value)
          order by membership.ordinality, file.ordinality
        )
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(product_settings -> 'bundledProductIds') = 'array'
              then product_settings -> 'bundledProductIds'
            else '[]'::jsonb
          end
        ) with ordinality membership(product_id, ordinality)
        join public.commerce_products child
          on child.id::text = membership.product_id
         and child.creator_id = new.creator_id
         and child.kind = 'digital_product'
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(child.settings -> 'files') = 'array' then child.settings -> 'files'
            else '[]'::jsonb
          end
        ) with ordinality file(value, ordinality)
      ), '[]'::jsonb)
    );
  else
    new.delivery_snapshot := '{}'::jsonb;
  end if;

  return new;
end;
$$;

revoke all on function public.snapshot_commerce_access_delivery() from public, anon, authenticated;

alter table public.profiles
  add column if not exists store_page_enabled boolean not null default false;
grant select (store_page_enabled) on public.profiles to anon, authenticated;

create table if not exists public.commerce_priority_dm_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.commerce_orders(id) on delete cascade,
  product_id uuid not null references public.commerce_products(id) on delete restrict,
  creator_id uuid not null references auth.users(id) on delete cascade,
  buyer_email text not null check (
    length(buyer_email) between 3 and 254
    and buyer_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  buyer_name text,
  message text not null check (length(message) between 1 and 10000),
  status text not null default 'unread' check (status in ('unread', 'read', 'replied', 'closed')),
  creator_reply text check (creator_reply is null or length(creator_reply) between 1 and 10000),
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_priority_dm_reply_state check (
    (status = 'replied' and creator_reply is not null and replied_at is not null)
    or status <> 'replied'
  )
);

create index if not exists commerce_priority_dm_creator_idx
  on public.commerce_priority_dm_requests(creator_id, created_at desc);

alter table public.commerce_priority_dm_requests enable row level security;
revoke all on public.commerce_priority_dm_requests from public, anon, authenticated;
grant select on public.commerce_priority_dm_requests to authenticated;
grant update (status, creator_reply, replied_at)
  on public.commerce_priority_dm_requests to authenticated;
grant all on public.commerce_priority_dm_requests to service_role;

drop policy if exists commerce_priority_dm_creator_select on public.commerce_priority_dm_requests;
create policy commerce_priority_dm_creator_select
  on public.commerce_priority_dm_requests
  for select to authenticated
  using (auth.uid() = creator_id);

drop policy if exists commerce_priority_dm_creator_update on public.commerce_priority_dm_requests;
create policy commerce_priority_dm_creator_update
  on public.commerce_priority_dm_requests
  for update to authenticated
  using (auth.uid() = creator_id)
  with check (auth.uid() = creator_id);

drop trigger if exists commerce_priority_dm_updated_at on public.commerce_priority_dm_requests;
create trigger commerce_priority_dm_updated_at
  before update on public.commerce_priority_dm_requests
  for each row execute function public.tg_set_updated_at();

comment on table public.commerce_priority_dm_requests is
  'Paid buyer messages and creator replies. Rows are created only after a commerce order is fulfilled.';
