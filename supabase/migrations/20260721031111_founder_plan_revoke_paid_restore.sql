-- Restore the billing plan after founder access is revoked regardless of which
-- supported billing integration created the subscription row.
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
