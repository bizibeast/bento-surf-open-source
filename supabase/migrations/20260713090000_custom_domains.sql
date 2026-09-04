-- Pro custom domains. Cloudflare identifiers and validation records are kept
-- private; public hostname resolution happens through a server function.
create table public.custom_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  hostname text not null unique,
  cloudflare_hostname_id text unique,
  status text not null default 'pending',
  ssl_status text not null default 'pending_validation',
  verification_records jsonb not null default '[]'::jsonb,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_domains_hostname_format check (
    hostname = lower(hostname)
    and length(hostname) between 4 and 253
    and hostname ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  )
);

create index custom_domains_active_hostname_idx
  on public.custom_domains(hostname)
  where status = 'active' and ssl_status = 'active';

grant select on public.custom_domains to authenticated;
grant all on public.custom_domains to service_role;

alter table public.custom_domains enable row level security;

create policy "custom_domains_owner_read"
  on public.custom_domains for select
  to authenticated
  using (auth.uid() = user_id);

create trigger custom_domains_updated_at
  before update on public.custom_domains
  for each row execute function public.tg_set_updated_at();

-- Plan entitlements are webhook-owned. The original table-level UPDATE grant
-- allowed an authenticated user to set is_pro directly through PostgREST.
revoke insert, update on public.profiles from authenticated;
grant update (
  username, display_name, bio, avatar_url, cover_url, theme, accent_color,
  badge_hidden, onboarded, noindex, font, meta_title, meta_description,
  primary_font, secondary_font, header_mode, pattern, pattern_settings
) on public.profiles to authenticated;
