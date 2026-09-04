-- Resend-backed lifecycle email outbox. Email delivery is deliberately kept
-- outside payment/auth transactions: database writes are the durable source of
-- truth and the Worker retries delivery independently.

create table if not exists public.email_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  product_updates boolean not null default false,
  weekly_digest boolean not null default false,
  marketing_unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_preferences enable row level security;
grant select, insert, update on public.email_preferences to authenticated;
grant all on public.email_preferences to service_role;

drop policy if exists email_preferences_owner_read on public.email_preferences;
create policy email_preferences_owner_read
  on public.email_preferences for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists email_preferences_owner_insert on public.email_preferences;
create policy email_preferences_owner_insert
  on public.email_preferences for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists email_preferences_owner_update on public.email_preferences;
create policy email_preferences_owner_update
  on public.email_preferences for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists email_preferences_updated_at on public.email_preferences;
create trigger email_preferences_updated_at
  before update on public.email_preferences
  for each row execute function public.tg_set_updated_at();

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (length(event_key) between 3 and 240),
  event_type text not null check (length(event_type) between 3 and 80),
  category text not null check (category in ('transactional', 'marketing')),
  recipient_email text not null check (
    length(recipient_email) between 3 and 254 and
    recipient_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  recipient_name text,
  user_id uuid references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed', 'suppressed')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  provider_email_id text,
  last_error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_outbox_pending_idx
  on public.email_outbox(available_at, created_at)
  where status = 'pending';
create index if not exists email_outbox_user_idx
  on public.email_outbox(user_id, created_at desc);

alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from anon, authenticated;
grant all on public.email_outbox to service_role;

create table if not exists public.email_suppressions (
  email text primary key check (
    length(email) between 3 and 254 and
    email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  reason text not null check (reason in ('bounce', 'complaint')),
  provider text not null default 'resend',
  provider_email_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_suppressions enable row level security;
revoke all on public.email_suppressions from anon, authenticated;
grant all on public.email_suppressions to service_role;

create table if not exists public.email_provider_events (
  event_id text primary key check (length(event_id) between 3 and 255),
  event_type text not null check (length(event_type) between 3 and 80),
  provider_email_id text,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'processing'
    check (status in ('processing', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 20),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_provider_events_email_idx
  on public.email_provider_events(provider_email_id, occurred_at desc);

alter table public.email_provider_events enable row level security;
revoke all on public.email_provider_events from anon, authenticated;
grant all on public.email_provider_events to service_role;

drop trigger if exists email_provider_events_updated_at on public.email_provider_events;
create trigger email_provider_events_updated_at
  before update on public.email_provider_events
  for each row execute function public.tg_set_updated_at();

drop trigger if exists email_outbox_updated_at on public.email_outbox;
create trigger email_outbox_updated_at
  before update on public.email_outbox
  for each row execute function public.tg_set_updated_at();

create or replace function public.prepare_new_user_email_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.email_preferences(user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  if new.email is not null and new.email_confirmed_at is not null then
    insert into public.email_outbox(
      event_key, event_type, category, recipient_email, recipient_name, user_id, payload
    ) values (
      'creator-welcome:' || new.id::text,
      'creator_welcome',
      'transactional',
      lower(new.email),
      nullif(coalesce(new.raw_user_meta_data->>'full_name', ''), ''),
      new.id,
      jsonb_build_object('confirmed_at', new.email_confirmed_at)
    ) on conflict (event_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_state_created on auth.users;
create trigger on_auth_user_email_state_created
  after insert on auth.users
  for each row execute function public.prepare_new_user_email_state();

create or replace function public.queue_confirmed_user_welcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null and new.email is not null then
    insert into public.email_outbox(
      event_key, event_type, category, recipient_email, recipient_name, user_id, payload
    ) values (
      'creator-welcome:' || new.id::text,
      'creator_welcome',
      'transactional',
      lower(new.email),
      nullif(coalesce(new.raw_user_meta_data->>'full_name', ''), ''),
      new.id,
      jsonb_build_object('confirmed_at', new.email_confirmed_at)
    ) on conflict (event_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.queue_confirmed_user_welcome();

create or replace function public.claim_email_outbox(p_limit integer default 25)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select id
    from public.email_outbox
    where (
      status = 'pending' and available_at <= now()
    ) or (
      status = 'processing' and updated_at <= now() - interval '10 minutes'
    )
    order by available_at, created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.email_outbox email
  set status = 'processing', attempts = email.attempts + 1, updated_at = now()
  from claimed
  where email.id = claimed.id
  returning email.*;
end;
$$;

revoke all on function public.claim_email_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer) to service_role;

create or replace function public.enqueue_due_lifecycle_emails()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
  weekly_count integer := 0;
begin
  insert into public.email_outbox(
    event_key, event_type, category, recipient_email, recipient_name, user_id, payload
  )
  select
    lifecycle.event_key,
    lifecycle.event_type,
    'marketing',
    lower(auth_user.email),
    nullif(profile.display_name, ''),
    profile.id,
    jsonb_build_object('username', profile.username)
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  join public.email_preferences preference on preference.user_id = profile.id
  cross join lateral (
    values
      ('onboarding-quick-win:' || profile.id::text, 'onboarding_quick_win', interval '1 day'),
      ('commerce-feature:' || profile.id::text, 'commerce_feature', interval '3 days'),
      ('pro-upgrade:' || profile.id::text, 'pro_upgrade', interval '10 days')
  ) as lifecycle(event_key, event_type, delay)
  where preference.product_updates
    and preference.marketing_unsubscribed_at is null
    and auth_user.email is not null
    and auth_user.email_confirmed_at is not null
    and auth_user.email_confirmed_at <= now() - lifecycle.delay
    and (lifecycle.event_type <> 'pro_upgrade' or not profile.is_pro)
  on conflict (event_key) do nothing;
  get diagnostics inserted_count = row_count;

  if extract(isodow from now() at time zone 'UTC') = 1 then
    insert into public.email_outbox(
      event_key, event_type, category, recipient_email, recipient_name, user_id, payload
    )
    select
      'weekly-digest:' || profile.id::text || ':' || date_trunc('week', now() at time zone 'UTC')::date,
      'weekly_digest',
      'marketing',
      lower(auth_user.email),
      nullif(profile.display_name, ''),
      profile.id,
      jsonb_build_object(
        'username', profile.username,
        'views', coalesce((select sum(day.views) from public.analytics_daily day
          where day.user_id = profile.id and day.day >= current_date - 7), 0),
        'clicks', coalesce((select sum(day.clicks) from public.analytics_daily day
          where day.user_id = profile.id and day.day >= current_date - 7), 0),
        'sales', coalesce((select count(*) from public.commerce_orders orders
          where orders.creator_id = profile.id and orders.status = 'paid'
            and orders.paid_at >= now() - interval '7 days'), 0)
      )
    from public.profiles profile
    join auth.users auth_user on auth_user.id = profile.id
    join public.email_preferences preference on preference.user_id = profile.id
    where preference.weekly_digest
      and preference.marketing_unsubscribed_at is null
      and auth_user.email is not null
      and auth_user.email_confirmed_at is not null
    on conflict (event_key) do nothing;
    get diagnostics weekly_count = row_count;
  end if;

  return inserted_count + weekly_count;
end;
$$;

revoke all on function public.enqueue_due_lifecycle_emails() from public, anon, authenticated;
grant execute on function public.enqueue_due_lifecycle_emails() to service_role;

revoke all on function public.prepare_new_user_email_state() from public, anon, authenticated;
revoke all on function public.queue_confirmed_user_welcome() from public, anon, authenticated;

notify pgrst, 'reload schema';
