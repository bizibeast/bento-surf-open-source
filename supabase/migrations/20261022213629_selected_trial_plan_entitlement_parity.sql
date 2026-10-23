-- Match profilePlanForBillingSurface: a trial keeps its selected plan, and an
-- allowed billing lifecycle takes precedence over the legacy trial timestamp.
-- CREATE OR REPLACE preserves the existing callers, ACL, and Brain RLS helpers.
create or replace function public.bento_effective_billing_plan(
  p_workspace_id uuid,
  p_surface text default 'tools'
)
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists(select 1 from public.bento_instance_settings where edition='self_hosted')
      then 'creator_plus'
    else coalesce((
      select plan from (
        select case
          when p.billing_lifecycle is null or (
            p.billing_lifecycle->>'deletingAt' is null and
            (p.billing_lifecycle->>case when p_surface='public' then 'publicStopAt' else 'toolsStopAt' end)::timestamptz>now()
          ) then case
            when p.billing_lifecycle is not null then p.billing_lifecycle->>'plan'
            when p.trial_ends_at is not null and p.trial_ends_at<=now() then 'free'
            else p.plan_id
          end
          else 'free'
        end as plan
        from public.profiles p where p.id=p_workspace_id
        union all
        select plan_id from public.complimentary_plan_grants
        where user_id=p_workspace_id and status='active' and expires_at>now()
      ) plans
      order by case plan when 'creator_plus' then 3 when 'creator' then 2 when 'store' then 1 else 0 end desc
      limit 1
    ),'free')
  end;
$$;
