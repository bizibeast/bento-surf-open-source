create table if not exists public.social_posting_schedules (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC',
  slots jsonb not null default '[]'::jsonb,
  natural_offset boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_posting_schedules_timezone_length
    check (char_length(timezone) between 1 and 100),
  constraint social_posting_schedules_slots_array
    check (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) <= 70)
);

alter table public.social_posting_schedules enable row level security;

grant select, insert, update, delete on public.social_posting_schedules to authenticated;

drop policy if exists social_posting_schedules_owner_select on public.social_posting_schedules;
create policy social_posting_schedules_owner_select
  on public.social_posting_schedules
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists social_posting_schedules_owner_insert on public.social_posting_schedules;
create policy social_posting_schedules_owner_insert
  on public.social_posting_schedules
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists social_posting_schedules_owner_update on public.social_posting_schedules;
create policy social_posting_schedules_owner_update
  on public.social_posting_schedules
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists social_posting_schedules_owner_delete on public.social_posting_schedules;
create policy social_posting_schedules_owner_delete
  on public.social_posting_schedules
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

notify pgrst, 'reload schema';
