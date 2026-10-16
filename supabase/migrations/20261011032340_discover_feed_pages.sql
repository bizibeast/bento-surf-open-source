-- Private pagination state is addressed only by opaque, owner-scoped page IDs.
-- The payload contains public sources, never the creator's Brain or feedback.
create table public.discover_feed_pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  direction_key text not null check (length(direction_key) between 1 and 800),
  platform text not null check (length(platform) between 1 and 40),
  request_key text not null check (request_key ~ '^[a-f0-9]{64}$'),
  items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 160),
  source_state jsonb not null
    check (jsonb_typeof(source_state) = 'object'
      and source_state ?& array['platforms', 'offset']
      and jsonb_typeof(source_state->'platforms') = 'object'
      and jsonb_typeof(source_state->'offset') = 'number'
      and source_state->>'offset' ~ '^[0-9]+$'
      and not jsonb_path_exists(source_state, '$.platforms.* ? (@.type() != "string" && @.type() != "null" && @ != false)')),
  has_more boolean not null default false,
  warnings jsonb not null default '[]'::jsonb
    check (jsonb_typeof(warnings) = 'array' and jsonb_array_length(warnings) <= 32
      and not jsonb_path_exists(warnings, '$[*] ? (@.type() != "string")')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  unique (user_id, direction_key, platform, request_key)
);

create index discover_feed_pages_expiry_idx on public.discover_feed_pages(expires_at);
alter table public.discover_feed_pages enable row level security;
revoke all on public.discover_feed_pages from public, anon, authenticated, service_role;
grant select, insert, delete on public.discover_feed_pages to service_role;

notify pgrst, 'reload schema';
