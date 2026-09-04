-- Founder-managed complimentary access for early testers. This is deliberately
-- separate from paid subscriptions so Dodo webhooks and gifted access cannot
-- overwrite each other's audit trail.
create table public.complimentary_plan_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan_id text not null check (plan_id in ('link', 'store')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index complimentary_plan_grants_status_granted_at_idx
  on public.complimentary_plan_grants (status, granted_at desc);

alter table public.complimentary_plan_grants enable row level security;
revoke all on table public.complimentary_plan_grants from public, anon, authenticated;
grant all on table public.complimentary_plan_grants to service_role;

comment on table public.complimentary_plan_grants is
  'Founder-issued Link or Store access that is not tied to a paid subscription.';

create or replace function public.get_founder_complimentary_plan_grants()
returns table (
  id uuid,
  user_id uuid,
  email text,
  username text,
  display_name text,
  plan_id text,
  status text,
  granted_at timestamptz,
  revoked_at timestamptz,
  granted_by_email text,
  last_sign_in_at timestamptz,
  user_created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    grant_row.id,
    grant_row.user_id,
    target_user.email::text,
    profile.username,
    profile.display_name,
    grant_row.plan_id,
    grant_row.status,
    grant_row.granted_at,
    grant_row.revoked_at,
    founder.email::text as granted_by_email,
    target_user.last_sign_in_at,
    target_user.created_at as user_created_at
  from public.complimentary_plan_grants grant_row
  join auth.users target_user on target_user.id = grant_row.user_id
  join public.profiles profile on profile.id = grant_row.user_id
  left join auth.users founder on founder.id = grant_row.granted_by
  order by grant_row.granted_at desc;
$$;

revoke all on function public.get_founder_complimentary_plan_grants()
  from public, anon, authenticated;
grant execute on function public.get_founder_complimentary_plan_grants() to service_role;

create or replace function public.grant_complimentary_plan(
  p_email text,
  p_plan_id text,
  p_granted_by uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if p_plan_id not in ('link', 'store') then
    raise exception 'Complimentary access must use the Link or Store plan.';
  end if;

  select auth_user.id into v_user_id
  from auth.users auth_user
  where lower(auth_user.email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'No Bento account was found for that email.';
  end if;

  if exists (
    select 1
    from public.subscriptions subscription
    where subscription.user_id = v_user_id
      and subscription.dodo_subscription_id is not null
      and subscription.status::text in ('active', 'trialing', 'past_due')
  ) then
    raise exception 'This creator already has a paid subscription. Manage their plan through billing.';
  end if;

  insert into public.complimentary_plan_grants (
    user_id, plan_id, status, granted_by, granted_at, updated_at, revoked_at
  ) values (
    v_user_id, p_plan_id, 'active', p_granted_by, now(), now(), null
  )
  on conflict (user_id) do update set
    plan_id = excluded.plan_id,
    status = 'active',
    granted_by = excluded.granted_by,
    granted_at = now(),
    updated_at = now(),
    revoked_at = null;

  update public.profiles
  set plan_id = p_plan_id, is_pro = true, updated_at = now()
  where id = v_user_id;
end;
$$;

revoke all on function public.grant_complimentary_plan(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.grant_complimentary_plan(text, text, uuid) to service_role;

create or replace function public.revoke_complimentary_plan(
  p_grant_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
begin
  update public.complimentary_plan_grants
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where id = p_grant_id and status = 'active'
  returning user_id into v_user_id;

  if v_user_id is null then
    raise exception 'That complimentary plan is no longer active.';
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.dodo_subscription_id is not null
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by subscription.updated_at desc
  limit 1;

  if coalesce(v_paid_plan, 'free') not in ('link', 'store') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'), updated_at = now()
  where id = v_user_id;
end;
$$;

revoke all on function public.revoke_complimentary_plan(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_complimentary_plan(uuid) to service_role;

notify pgrst, 'reload schema';
