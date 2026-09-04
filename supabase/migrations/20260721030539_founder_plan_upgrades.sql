-- Founder access is an entitlement overlay, not a billing mutation. A founder
-- may upgrade any creator, including an active paid subscriber. The highest
-- active plan wins so a Link grant can never downgrade a paid Store account.
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
  v_paid_plan text := 'free';
  v_effective_plan text;
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

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by subscription.updated_at desc
  limit 1;

  if coalesce(v_paid_plan, 'free') not in ('link', 'store') then
    v_paid_plan := 'free';
  end if;

  v_effective_plan := case
    when p_plan_id = 'store' or v_paid_plan = 'store' then 'store'
    else 'link'
  end;

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
  set plan_id = v_effective_plan, is_pro = true, updated_at = now()
  where id = v_user_id;
end;
$$;

revoke all on function public.grant_complimentary_plan(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.grant_complimentary_plan(text, text, uuid) to service_role;

notify pgrst, 'reload schema';
