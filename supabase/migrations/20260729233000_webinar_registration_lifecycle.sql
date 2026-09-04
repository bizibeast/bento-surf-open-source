-- Durable webinar registrations are created from access grants. Event details are
-- snapshotted so a creator edit cannot silently change a buyer's purchased event.

create table if not exists public.commerce_webinar_registrations (
  id uuid primary key default gen_random_uuid(),
  access_grant_id uuid not null unique
    references public.commerce_access_grants(id) on delete cascade,
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  buyer_email text not null,
  buyer_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  join_url text,
  replay_url text,
  status text not null default 'registered'
    check (status in ('registered', 'attended', 'no_show', 'canceled')),
  reminder_24h_sent_at timestamptz,
  reminder_1h_sent_at timestamptz,
  replay_ready_notified_at timestamptz,
  attended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (length(buyer_email) between 3 and 254),
  check (join_url is null or length(join_url) <= 2048),
  check (replay_url is null or length(replay_url) <= 2048)
);

create index if not exists commerce_webinar_registrations_creator_idx
  on public.commerce_webinar_registrations(creator_id, starts_at desc);
create index if not exists commerce_webinar_registrations_product_idx
  on public.commerce_webinar_registrations(product_id, starts_at desc);
create index if not exists commerce_webinar_registrations_reminders_idx
  on public.commerce_webinar_registrations(status, starts_at)
  where status <> 'canceled';
create index if not exists commerce_webinar_registrations_replay_idx
  on public.commerce_webinar_registrations(ends_at)
  where replay_url is not null and replay_ready_notified_at is null;

alter table public.commerce_webinar_registrations enable row level security;
revoke all on public.commerce_webinar_registrations from anon;
revoke all on public.commerce_webinar_registrations from authenticated;
grant select on public.commerce_webinar_registrations to authenticated;
grant update (status, attended_at)
  on public.commerce_webinar_registrations to authenticated;
grant all on public.commerce_webinar_registrations to service_role;

drop policy if exists commerce_webinar_registrations_creator_read
  on public.commerce_webinar_registrations;
create policy commerce_webinar_registrations_creator_read
  on public.commerce_webinar_registrations for select
  to authenticated
  using (auth.uid() = creator_id);

drop policy if exists commerce_webinar_registrations_creator_update
  on public.commerce_webinar_registrations;
create policy commerce_webinar_registrations_creator_update
  on public.commerce_webinar_registrations for update
  to authenticated
  using (auth.uid() = creator_id)
  with check (auth.uid() = creator_id);

drop trigger if exists commerce_webinar_registrations_updated_at
  on public.commerce_webinar_registrations;
create trigger commerce_webinar_registrations_updated_at
  before update on public.commerce_webinar_registrations
  for each row execute function public.tg_set_updated_at();

create or replace function public.sync_commerce_webinar_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row public.commerce_products%rowtype;
  order_row public.commerce_orders%rowtype;
  event_start timestamptz;
  duration_minutes integer;
  registration_status text;
begin
  select * into product_row
  from public.commerce_products
  where id = new.product_id and kind = 'webinar';

  if not found then
    return new;
  end if;

  begin
    event_start := nullif(product_row.settings->>'startsAt', '')::timestamptz;
  exception when others then
    event_start := null;
  end;

  if event_start is null then
    return new;
  end if;

  begin
    duration_minutes := coalesce((product_row.settings->>'durationMinutes')::integer, 60);
  exception when others then
    duration_minutes := 60;
  end;
  duration_minutes := greatest(15, least(duration_minutes, 1440));
  registration_status := case when new.status = 'active' then 'registered' else 'canceled' end;

  select * into order_row
  from public.commerce_orders
  where id = new.order_id;

  insert into public.commerce_webinar_registrations (
    access_grant_id,
    order_id,
    product_id,
    creator_id,
    buyer_email,
    buyer_name,
    starts_at,
    ends_at,
    timezone,
    join_url,
    replay_url,
    status
  ) values (
    new.id,
    new.order_id,
    new.product_id,
    new.creator_id,
    lower(new.buyer_email),
    nullif(order_row.buyer_name, ''),
    event_start,
    event_start + make_interval(mins => duration_minutes),
    coalesce(nullif(product_row.settings->>'timezone', ''), 'UTC'),
    nullif(product_row.settings->>'joinUrl', ''),
    nullif(product_row.settings->>'replayUrl', ''),
    registration_status
  )
  on conflict (access_grant_id) do update set
    status = case
      when excluded.status = 'canceled' then 'canceled'
      when public.commerce_webinar_registrations.status = 'canceled' then 'registered'
      else public.commerce_webinar_registrations.status
    end,
    buyer_email = excluded.buyer_email,
    buyer_name = coalesce(
      public.commerce_webinar_registrations.buyer_name,
      excluded.buyer_name
    );

  return new;
end;
$$;

revoke all on function public.sync_commerce_webinar_registration()
  from public, anon, authenticated;
grant execute on function public.sync_commerce_webinar_registration() to service_role;

drop trigger if exists commerce_access_grants_sync_webinar_registration
  on public.commerce_access_grants;
create trigger commerce_access_grants_sync_webinar_registration
  after insert or update of status on public.commerce_access_grants
  for each row execute function public.sync_commerce_webinar_registration();

-- Register already-fulfilled webinar orders without mutating their access tokens.
update public.commerce_access_grants
set status = status
where product_id in (
  select id from public.commerce_products where kind = 'webinar'
);

comment on table public.commerce_webinar_registrations is
  'Immutable per-buyer webinar schedule and delivery snapshot with reminder and attendance state.';
