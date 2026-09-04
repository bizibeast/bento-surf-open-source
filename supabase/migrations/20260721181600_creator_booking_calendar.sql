-- Native creator scheduling, Google Calendar/Meet, Fathom recordings, and
-- post-call reviews. OAuth credentials are encrypted by the application; the
-- database only stores ciphertext and never exposes these tables to clients.

create table if not exists public.booking_calendar_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.booking_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  provider_user_id text not null,
  email text not null,
  display_name text,
  calendar_id text not null default 'primary',
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'error', 'revoked')),
  is_default boolean not null default false,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, provider_user_id)
);

create unique index if not exists booking_calendar_one_default_idx
  on public.booking_calendar_connections(user_id)
  where is_default and status = 'active';

create table if not exists public.booking_availability (
  creator_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC',
  weekly_rules jsonb not null default '[
    {"day":1,"start":"09:00","end":"17:00"},
    {"day":2,"start":"09:00","end":"17:00"},
    {"day":3,"start":"09:00","end":"17:00"},
    {"day":4,"start":"09:00","end":"17:00"},
    {"day":5,"start":"09:00","end":"17:00"}
  ]'::jsonb,
  date_overrides jsonb not null default '[]'::jsonb,
  minimum_notice_minutes integer not null default 120
    check (minimum_notice_minutes between 0 and 525600),
  maximum_days_ahead integer not null default 60
    check (maximum_days_ahead between 1 and 365),
  buffer_before_minutes integer not null default 0
    check (buffer_before_minutes between 0 and 480),
  buffer_after_minutes integer not null default 10
    check (buffer_after_minutes between 0 and 480),
  slot_interval_minutes integer not null default 30
    check (slot_interval_minutes between 5 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.booking_fathom_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.booking_fathom_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_user_id text not null,
  email text,
  display_name text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  token_expires_at timestamptz not null,
  scopes text[] not null default '{public_api}',
  status text not null default 'active' check (status in ('active', 'error', 'revoked')),
  is_default boolean not null default false,
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider_user_id)
);

create unique index if not exists booking_fathom_one_default_idx
  on public.booking_fathom_connections(user_id)
  where is_default and status = 'active';

alter table public.commerce_bookings
  add column if not exists calendar_connection_id uuid
    references public.booking_calendar_connections(id) on delete set null,
  add column if not exists google_event_id text,
  add column if not exists google_event_url text,
  add column if not exists fathom_connection_id uuid
    references public.booking_fathom_connections(id) on delete set null,
  add column if not exists recording_requested boolean not null default false,
  add column if not exists recording_status text not null default 'not_requested',
  add column if not exists recording_share_url text,
  add column if not exists recording_playback_url text,
  add column if not exists completed_at timestamptz,
  add column if not exists review_requested_at timestamptz;

alter table public.commerce_bookings
  drop constraint if exists commerce_bookings_recording_status_check;
alter table public.commerce_bookings
  add constraint commerce_bookings_recording_status_check
  check (recording_status in ('not_requested', 'pending', 'ready', 'unavailable'));

create index if not exists commerce_bookings_followup_idx
  on public.commerce_bookings(ends_at)
  where status = 'confirmed' and review_requested_at is null;
create index if not exists commerce_bookings_recording_sync_idx
  on public.commerce_bookings(creator_id, ends_at)
  where recording_requested and recording_status = 'pending';

alter table public.commerce_payment_sessions
  add column if not exists recording_addon_selected boolean not null default false,
  add column if not exists recording_addon_amount integer not null default 0
    check (recording_addon_amount >= 0);

create table if not exists public.booking_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.commerce_bookings(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  reviewer_email text not null,
  reviewer_name text,
  token_hash text not null unique,
  rating smallint check (rating between 1 and 5),
  body text check (char_length(body) <= 5000),
  is_public boolean not null default true,
  requested_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists booking_reviews_creator_idx
  on public.booking_reviews(creator_id, submitted_at desc);

alter table public.booking_calendar_oauth_states enable row level security;
alter table public.booking_calendar_connections enable row level security;
alter table public.booking_availability enable row level security;
alter table public.booking_fathom_oauth_states enable row level security;
alter table public.booking_fathom_connections enable row level security;
alter table public.booking_reviews enable row level security;

grant all on public.booking_calendar_oauth_states to service_role;
grant all on public.booking_calendar_connections to service_role;
grant all on public.booking_fathom_oauth_states to service_role;
grant all on public.booking_fathom_connections to service_role;
grant all on public.booking_reviews to service_role;

grant select, insert, update, delete on public.booking_availability to authenticated;
grant select on public.booking_calendar_connections to authenticated;
grant select on public.booking_fathom_connections to authenticated;
grant select on public.booking_reviews to authenticated;

drop policy if exists "Creators manage booking availability" on public.booking_availability;
create policy "Creators manage booking availability"
  on public.booking_availability for all to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);

drop policy if exists "Creators read calendar connections" on public.booking_calendar_connections;
create policy "Creators read calendar connections"
  on public.booking_calendar_connections for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Creators read Fathom connections" on public.booking_fathom_connections;
create policy "Creators read Fathom connections"
  on public.booking_fathom_connections for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Creators read booking reviews" on public.booking_reviews;
create policy "Creators read booking reviews"
  on public.booking_reviews for select to authenticated
  using ((select auth.uid()) = creator_id);

drop trigger if exists booking_calendar_connections_updated_at
  on public.booking_calendar_connections;
create trigger booking_calendar_connections_updated_at
  before update on public.booking_calendar_connections
  for each row execute function public.tg_set_updated_at();

drop trigger if exists booking_availability_updated_at on public.booking_availability;
create trigger booking_availability_updated_at
  before update on public.booking_availability
  for each row execute function public.tg_set_updated_at();

drop trigger if exists booking_fathom_connections_updated_at
  on public.booking_fathom_connections;
create trigger booking_fathom_connections_updated_at
  before update on public.booking_fathom_connections
  for each row execute function public.tg_set_updated_at();

drop trigger if exists booking_reviews_updated_at on public.booking_reviews;
create trigger booking_reviews_updated_at
  before update on public.booking_reviews
  for each row execute function public.tg_set_updated_at();

-- OAuth state and token tables intentionally have no anon/authenticated write
-- policies. Mutations go through authenticated server functions using the
-- service role after state and ownership checks.
