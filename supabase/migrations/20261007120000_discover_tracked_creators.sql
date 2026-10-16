create table public.creator_discover_follows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  profile_url text not null check (length(profile_url) between 1 and 500),
  platform text not null check (platform in ('Facebook','Reddit','Instagram','X','Threads','LinkedIn','YouTube','TikTok')),
  name text not null check (length(name) between 1 and 120),
  topics text not null default '' check (length(topics) <= 200),
  avatar_url text,
  active boolean not null default true,
  last_error text,
  last_checked_at timestamptz,
  post_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, profile_url)
);
alter table public.creator_discover_follows enable row level security;
revoke all on public.creator_discover_follows from anon, authenticated;
grant select on public.creator_discover_follows to authenticated;
grant all on public.creator_discover_follows to service_role;
create policy "Creators read their own tracked profiles"
  on public.creator_discover_follows for select to authenticated
  using (user_id = (select auth.uid()));
create trigger creator_discover_follows_updated_at before update on public.creator_discover_follows
  for each row execute function public.tg_set_updated_at();
