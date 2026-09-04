alter table public.complimentary_plan_grants
  add column if not exists expires_at timestamptz;

update public.complimentary_plan_grants
set expires_at = granted_at + interval '1 year'
where expires_at is null;

alter table public.complimentary_plan_grants
  alter column expires_at set default (now() + interval '1 year'),
  alter column expires_at set not null;

alter table public.complimentary_plan_grants
  drop constraint if exists complimentary_plan_grants_status_check;
alter table public.complimentary_plan_grants
  add constraint complimentary_plan_grants_status_check
  check (status in ('active', 'revoked', 'expired'));

alter table public.complimentary_plan_grants
  drop constraint if exists complimentary_plan_grants_expiry_check;
alter table public.complimentary_plan_grants
  add constraint complimentary_plan_grants_expiry_check
  check (expires_at > granted_at);

create index if not exists complimentary_plan_grants_active_expiry_idx
  on public.complimentary_plan_grants (expires_at)
  where status = 'active';

comment on column public.complimentary_plan_grants.expires_at is
  'Exact time founder-issued access stops. Existing grants were given one year from their original grant date.';

drop function if exists public.get_founder_complimentary_plan_grants();
create function public.get_founder_complimentary_plan_grants()
returns table (
  id uuid,
  user_id uuid,
  email text,
  username text,
  display_name text,
  plan_id text,
  status text,
  granted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  granted_by_email text,
  last_sign_in_at timestamptz,
  user_created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    grant_row.id,
    grant_row.user_id,
    target_user.email::text,
    profile.username,
    profile.display_name,
    grant_row.plan_id,
    case
      when grant_row.status = 'active' and grant_row.expires_at <= now() then 'expired'
      else grant_row.status
    end,
    grant_row.granted_at,
    grant_row.expires_at,
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

drop function if exists public.grant_complimentary_plan(text, text, uuid);
create function public.grant_complimentary_plan(
  p_email text,
  p_plan_id text,
  p_granted_by uuid,
  p_duration_days integer default 365
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
  v_effective_plan text;
begin
  if p_plan_id not in ('link', 'store') then
    raise exception 'Complimentary access must use the Link or Store plan.';
  end if;

  if p_duration_days is null or p_duration_days < 1 or p_duration_days > 3650 then
    raise exception 'Complimentary access duration must be between 1 and 3650 days.';
  end if;

  select auth_user.id into v_user_id
  from auth.users auth_user
  where lower(auth_user.email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'No Bento account was found for that email.';
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by
    case subscription.plan_id when 'store' then 0 when 'link' then 1 else 2 end,
    subscription.updated_at desc
  limit 1;

  if coalesce(v_paid_plan, 'free') not in ('link', 'store') then
    v_paid_plan := 'free';
  end if;

  v_effective_plan := case
    when p_plan_id = 'store' or v_paid_plan = 'store' then 'store'
    else 'link'
  end;

  insert into public.complimentary_plan_grants (
    user_id,
    plan_id,
    status,
    granted_by,
    granted_at,
    expires_at,
    updated_at,
    revoked_at
  ) values (
    v_user_id,
    p_plan_id,
    'active',
    p_granted_by,
    now(),
    now() + make_interval(days => p_duration_days),
    now(),
    null
  )
  on conflict (user_id) do update set
    plan_id = excluded.plan_id,
    status = 'active',
    granted_by = excluded.granted_by,
    granted_at = excluded.granted_at,
    expires_at = excluded.expires_at,
    updated_at = now(),
    revoked_at = null;

  update public.profiles
  set plan_id = v_effective_plan, is_pro = true, updated_at = now()
  where id = v_user_id;
end;
$$;

create or replace function public.expire_complimentary_plan_grant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
begin
  update public.complimentary_plan_grants
  set status = 'expired', updated_at = now()
  where id = p_grant_id
    and status = 'active'
    and expires_at <= now()
  returning user_id into v_user_id;

  if v_user_id is null then
    return;
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by
    case subscription.plan_id when 'store' then 0 when 'link' then 1 else 2 end,
    subscription.updated_at desc
  limit 1;

  if coalesce(v_paid_plan, 'free') not in ('link', 'store') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'), updated_at = now()
  where id = v_user_id;
end;
$$;

revoke all on function public.get_founder_complimentary_plan_grants()
  from public, anon, authenticated;
revoke all on function public.grant_complimentary_plan(text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.expire_complimentary_plan_grant(uuid)
  from public, anon, authenticated;

grant execute on function public.get_founder_complimentary_plan_grants() to service_role;
grant execute on function public.grant_complimentary_plan(text, text, uuid, integer)
  to service_role;
grant execute on function public.expire_complimentary_plan_grant(uuid) to service_role;

notify pgrst, 'reload schema';
