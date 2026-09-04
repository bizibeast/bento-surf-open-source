-- Keep public-page reads and bursty analytics ingestion efficient as traffic grows.

alter table public.profile_views
  add column if not exists event_id uuid;

alter table public.block_clicks
  add column if not exists event_id uuid;

create unique index if not exists profile_views_event_id_idx
  on public.profile_views(event_id);

create unique index if not exists block_clicks_event_id_idx
  on public.block_clicks(event_id);

create index if not exists blocks_public_page_order_idx
  on public.blocks(user_id, page_id, position);

create index if not exists pages_public_order_idx
  on public.pages(user_id, position);
