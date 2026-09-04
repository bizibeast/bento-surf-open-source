
-- ============ ENUMS ============
create type public.app_role as enum ('user', 'admin');
create type public.block_type as enum (
  'social_link','generic_link','image','image_gallery','video','spotify','link_preview','map',
  'heading','note','quote','email_capture','booking','tip_jar'
);
create type public.theme_mode as enum ('light','dark','system');
create type public.subscription_status as enum ('active','trialing','past_due','canceled','incomplete');

-- ============ PROFILES ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null default '',
  bio text not null default '',
  avatar_url text,
  cover_url text,
  theme public.theme_mode not null default 'system',
  accent_color text not null default 'sky',
  is_pro boolean not null default false,
  badge_hidden boolean not null default false,
  stripe_customer_id text,
  stripe_account_id text,
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_]{3,30}$')
);

grant select on public.profiles to anon, authenticated;
grant insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

create policy "profiles_public_read"
  on public.profiles for select
  to anon, authenticated
  using (true);

create policy "profiles_owner_insert"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "profiles_owner_update"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ============ USER ROLES ============
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  unique(user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

create policy "user_roles_own_read"
  on public.user_roles for select
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role);
$$;

-- ============ BLOCKS ============
create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type public.block_type not null,
  content jsonb not null default '{}'::jsonb,
  x integer not null default 0,
  y integer not null default 0,
  w integer not null default 2,
  h integer not null default 2,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index blocks_user_id_idx on public.blocks(user_id);

grant select on public.blocks to anon, authenticated;
grant insert, update, delete on public.blocks to authenticated;
grant all on public.blocks to service_role;

alter table public.blocks enable row level security;

create policy "blocks_public_read"
  on public.blocks for select
  to anon, authenticated
  using (true);

create policy "blocks_owner_all"
  on public.blocks for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============ SUBSCRIPTIONS ============
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  status public.subscription_status not null,
  price_id text,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

alter table public.subscriptions enable row level security;

create policy "subs_owner_read"
  on public.subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

-- ============ TIPS ============
create table public.tips (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  amount_cents integer not null,
  currency text not null default 'usd',
  message text,
  supporter_email text,
  supporter_name text,
  stripe_payment_intent text unique,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index tips_recipient_idx on public.tips(recipient_user_id);

grant select on public.tips to authenticated;
grant all on public.tips to service_role;

alter table public.tips enable row level security;

create policy "tips_recipient_read"
  on public.tips for select
  to authenticated
  using (auth.uid() = recipient_user_id);

-- ============ EMAIL SIGNUPS ============
create table public.email_signups (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  unique(owner_user_id, email)
);

create index email_signups_owner_idx on public.email_signups(owner_user_id);

grant select on public.email_signups to authenticated;
grant all on public.email_signups to service_role;

alter table public.email_signups enable row level security;

create policy "email_signups_owner_read"
  on public.email_signups for select
  to authenticated
  using (auth.uid() = owner_user_id);

-- ============ ANALYTICS ============
create table public.profile_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  visitor_hash text,
  referrer text,
  created_at timestamptz not null default now()
);
create index profile_views_user_idx on public.profile_views(user_id, created_at desc);

grant select on public.profile_views to authenticated;
grant all on public.profile_views to service_role;
alter table public.profile_views enable row level security;
create policy "pv_owner_read" on public.profile_views for select
  to authenticated using (auth.uid() = user_id);

create table public.block_clicks (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references public.blocks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  visitor_hash text,
  created_at timestamptz not null default now()
);
create index block_clicks_user_idx on public.block_clicks(user_id, created_at desc);

grant select on public.block_clicks to authenticated;
grant all on public.block_clicks to service_role;
alter table public.block_clicks enable row level security;
create policy "bc_owner_read" on public.block_clicks for select
  to authenticated using (auth.uid() = user_id);

-- ============ TRIGGERS ============
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();
create trigger blocks_updated_at before update on public.blocks
  for each row execute function public.tg_set_updated_at();
create trigger subs_updated_at before update on public.subscriptions
  for each row execute function public.tg_set_updated_at();

-- Auto-create profile + assign default 'user' role on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  base_username text;
  candidate text;
  i integer := 0;
begin
  base_username := lower(regexp_replace(coalesce(split_part(new.email,'@',1),'user'), '[^a-z0-9_]', '', 'g'));
  if length(base_username) < 3 then base_username := 'user' || substr(new.id::text,1,6); end if;
  candidate := substr(base_username,1,24);
  while exists(select 1 from public.profiles where username = candidate) loop
    i := i + 1;
    candidate := substr(base_username,1,20) || i::text;
  end loop;
  insert into public.profiles(id, username, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data->>'full_name',''));
  insert into public.user_roles(user_id, role) values (new.id, 'user');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
