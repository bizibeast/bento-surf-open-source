-- Complimentary access belongs to a workspace, including workspaces whose ID
-- differs from the owner's auth user ID.
alter table public.complimentary_plan_grants
  drop constraint if exists complimentary_plan_grants_user_id_fkey;
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.complimentary_plan_grants'::regclass
      and conname = 'complimentary_plan_grants_user_id_workspace_fkey'
  ) then
    alter table public.complimentary_plan_grants
      add constraint complimentary_plan_grants_user_id_workspace_fkey
      foreign key (user_id) references public.profiles(id) on delete cascade;
  end if;
end; $$;

create or replace function public.get_founder_complimentary_workspaces(p_email text)
returns table (
  workspace_id uuid,
  username text,
  display_name text,
  workspace_status text,
  plan_id text,
  complimentary_plan_id text,
  complimentary_expires_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select profile.id,
         profile.username,
         profile.display_name,
         profile.workspace_status,
         profile.plan_id,
         case when grant_row.status = 'active' and grant_row.expires_at > now()
              then grant_row.plan_id else null end,
         case when grant_row.status = 'active' and grant_row.expires_at > now()
              then grant_row.expires_at else null end
  from auth.users owner
  join public.workspace_memberships membership
    on membership.auth_user_id = owner.id
   and membership.role = 'owner'
   and membership.status = 'active'
  join public.profiles profile on profile.id = membership.workspace_id
  left join public.complimentary_plan_grants grant_row on grant_row.user_id = profile.id
  where lower(owner.email) = lower(trim(p_email))
  order by membership.created_at, profile.id;
$$;

revoke all on function public.get_founder_complimentary_workspaces(text)
  from public, anon, authenticated;
grant execute on function public.get_founder_complimentary_workspaces(text) to service_role;

-- Five arguments deliberately avoid changing the existing four-argument RPC
-- while the application and migration roll out independently.
create function public.grant_complimentary_plan(
  p_email text,
  p_plan_id text,
  p_granted_by uuid,
  p_duration_days integer,
  p_workspace_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_account_id uuid;
  v_paid_plan text := 'free';
  v_effective_plan text;
begin
  if p_plan_id not in ('store', 'creator', 'creator_plus') then
    raise exception 'Complimentary access must use Store, Creator or Creator Plus plan.';
  end if;
  if p_duration_days is null or p_duration_days < 1 or p_duration_days > 3650 then
    raise exception 'Complimentary access duration must be between 1 and 3650 days.';
  end if;
  select id into v_account_id from auth.users
    where lower(email) = lower(trim(p_email)) limit 1;
  if v_account_id is null then
    raise exception 'No Bento account was found for that email.';
  end if;
  if p_workspace_id is null then
    raise exception 'That workspace is not owned by that account.';
  end if;

  -- Match the profile-first lock order used by retention and grant revocation.
  perform 1 from public.profiles where id = p_workspace_id for update;
  if not found then
    raise exception 'That workspace is not owned by that account.';
  end if;
  perform 1 from public.workspace_memberships membership
    where membership.auth_user_id = v_account_id
      and membership.workspace_id = p_workspace_id
      and membership.role = 'owner'
      and membership.status = 'active'
    for share;
  if not found then
    raise exception 'That workspace is not owned by that account.';
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = p_workspace_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by case subscription.plan_id
    when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 else 3 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator', 'creator_plus') then
    v_paid_plan := 'free';
  end if;
  v_effective_plan := case
    when p_plan_id = 'creator_plus' or v_paid_plan = 'creator_plus' then 'creator_plus'
    when p_plan_id = 'creator' or v_paid_plan = 'creator' then 'creator'
    else 'store' end;

  insert into public.complimentary_plan_grants (
    user_id, plan_id, status, granted_by, granted_at, expires_at, updated_at, revoked_at
  ) values (
    p_workspace_id, p_plan_id, 'active', p_granted_by, now(),
    now() + make_interval(days => p_duration_days), now(), null
  ) on conflict (user_id) do update set
    plan_id = excluded.plan_id,
    status = 'active',
    granted_by = excluded.granted_by,
    granted_at = excluded.granted_at,
    expires_at = excluded.expires_at,
    updated_at = now(),
    revoked_at = null;

  update public.profiles set
    plan_id = v_effective_plan,
    is_pro = true,
    workspace_status = 'active',
    updated_at = now()
  where id = p_workspace_id;
end;
$$;

revoke all on function public.grant_complimentary_plan(text, text, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.grant_complimentary_plan(text, text, uuid, integer, uuid)
  to service_role;

create or replace function public.get_founder_complimentary_plan_grants()
returns table (
  id uuid, user_id uuid, email text, username text, display_name text,
  plan_id text, status text, granted_at timestamptz, expires_at timestamptz,
  revoked_at timestamptz, granted_by_email text, last_sign_in_at timestamptz,
  user_created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select grant_row.id,
         grant_row.user_id,
         owner.email::text,
         profile.username,
         profile.display_name,
         grant_row.plan_id,
         case when grant_row.status = 'active' and grant_row.expires_at <= now()
              then 'expired' else grant_row.status end,
         grant_row.granted_at,
         grant_row.expires_at,
         grant_row.revoked_at,
         founder.email::text,
         owner.last_sign_in_at,
         owner.created_at
  from public.complimentary_plan_grants grant_row
  join public.profiles profile on profile.id = grant_row.user_id
  join lateral (
    select account.email, account.last_sign_in_at, account.created_at
    from public.workspace_memberships membership
    join auth.users account on account.id = membership.auth_user_id
    where membership.workspace_id = grant_row.user_id
      and membership.role = 'owner'
    order by (membership.status = 'active') desc, membership.created_at
    limit 1
  ) owner on true
  left join auth.users founder on founder.id = grant_row.granted_by
  order by grant_row.granted_at desc;
$$;
