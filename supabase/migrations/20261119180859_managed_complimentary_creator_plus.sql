begin;

-- Explicit operator-funded access is separate from ordinary complimentary plans.
-- An application/service API key cannot issue grants; only a database operator can.
create table private.managed_provider_complimentary_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.profiles(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  complimentary_grant_id uuid not null unique references public.complimentary_plan_grants(id) on delete cascade,
  product_id text not null check (length(product_id) between 1 and 120),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > created_at),
  revoked_at timestamptz,
  granted_by uuid not null references auth.users(id),
  reason text not null check (length(reason) between 3 and 1000)
);
alter table private.managed_provider_complimentary_grants enable row level security;
revoke all on private.managed_provider_complimentary_grants from public, anon, authenticated, service_role;
comment on table private.managed_provider_complimentary_grants is
  'Operator-funded managed Creator+ allowances. No automatic grant from a profile, trial or complimentary plan. Existing owner/global usage caps apply.';

-- Complete both hard ceilings without increasing or resetting any counter.
do $$begin
  if not exists(select 1 from pg_constraint where conrelid='public.managed_provider_spend_policy'::regclass and conname='managed_monthly_hard_ceiling') then
    alter table public.managed_provider_spend_policy add constraint managed_monthly_hard_ceiling check (monthly_microusd <= 25000000);
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.managed_provider_spend_policy'::regclass and conname='managed_weekly_hard_ceiling') then
    alter table public.managed_provider_spend_policy add constraint managed_weekly_hard_ceiling check (weekly_microusd <= 6250000);
  end if;
end $$;

-- Preserve the paid-subscription verifier exactly, including refund/revenue checks.
create function private.managed_provider_paid_subscription_period(
  p_workspace_id uuid, p_product_id text, p_now timestamptz, p_monthly_microusd bigint
) returns table(payment_id text, ends_at timestamptz)
language sql stable set search_path = '' as $$
  select paid.payment_id, s.current_period_end
      from public.subscriptions s
      join public.profiles w on w.id = s.user_id
      cross join lateral (
        select p.* from public.payments p
        where p.subscription_id = s.dodo_subscription_id
          and p.status = 'succeeded'
          and p.dodo_charge_type in ('new', 'renewal')
          and (p.product_id = s.product_id or (
            p.product_id is null and p.billing_contract_catalog = '2026-11-managed'
          ))
          and p.occurred_at between s.current_period_end - interval '32 days' and p_now
        order by p.occurred_at desc, p.payment_id desc limit 1
      ) paid
      cross join lateral (
        select coalesce(sum(r.amount), 0) as amount,
          coalesce(bool_and(r.currency = 'USD'), true) as usd_only
        from public.refunds r where r.payment_id = paid.payment_id and r.status = 'succeeded'
      ) refunds
      where nullif(p_product_id, '') is not null
        and exists (select 1 from public.bento_instance_settings where edition = 'hosted')
        and s.user_id = p_workspace_id and w.workspace_status = 'active'
        and w.billing_lifecycle->>'deletingAt' is null
        and s.billing_catalog = '2026-11-managed' and s.plan_id = 'creator_plus'
        and s.status = 'active' and s.trial_ends_at is null
        and s.product_id = p_product_id and lower(s.billing_interval) in ('month', 'monthly')
        and s.current_period_end > p_now
        and paid.total_amount > 0
        and paid.settlement_currency = 'USD' and paid.settlement_amount is not null
        and (paid.currency = 'USD' or coalesce(paid.tax, 0) = 0 or paid.settlement_tax is not null)
        and coalesce(paid.refund_status, '') in ('', 'partial')
        and (coalesce(paid.refund_status, '') <> 'partial' or refunds.amount > 0)
        -- Where the charge uses adaptive currency, a foreign-currency refund
        -- cannot be subtracted reliably from a USD settlement.
        and (refunds.amount = 0 or (paid.currency = 'USD' and refunds.usd_only))
        and (
          least(
            paid.settlement_amount - coalesce(paid.settlement_tax, 0),
            case when paid.currency = 'USD' then paid.total_amount - coalesce(paid.tax, 0)
              else paid.settlement_amount end
          ) - refunds.amount
        ) * 10000 >= 2 * p_monthly_microusd;
$$;

-- Keep the existing function OID/signature so the public atomic meter and every
-- managed workflow continue using one accounting path. The historical payment_id
-- field contains an explicit "complimentary:" funding reference for grants;
-- no payment/subscription rows are fabricated.
create or replace function private.managed_provider_paid_period(
  p_workspace_id uuid, p_product_id text, p_now timestamptz, p_monthly_microusd bigint
) returns table(payment_id text, ends_at timestamptz)
language sql stable set search_path = '' as $$
  with paid as materialized (
    select * from private.managed_provider_paid_subscription_period(
      p_workspace_id,p_product_id,p_now,p_monthly_microusd
    )
  )
  select paid.payment_id,paid.ends_at from paid
  union all
  select 'complimentary:' || funded.id::text || ':' || to_char(p_now at time zone 'UTC','YYYY-MM'),
    least(funded.expires_at,plan_grant.expires_at,
      ((date_trunc('month',p_now at time zone 'UTC') + interval '1 month') at time zone 'UTC'))
  from private.managed_provider_complimentary_grants funded
  join public.complimentary_plan_grants plan_grant on plan_grant.id=funded.complimentary_grant_id
    and plan_grant.user_id=funded.workspace_id
  join public.profiles workspace on workspace.id=funded.workspace_id
  where not exists(select 1 from paid)
    and funded.workspace_id=p_workspace_id and funded.product_id=p_product_id
    and funded.revoked_at is null and funded.created_at<=p_now and funded.expires_at>p_now
    and funded.owner_id=private.managed_provider_workspace_owner(p_workspace_id,null)
    and plan_grant.plan_id='creator_plus' and plan_grant.status='active' and plan_grant.expires_at>p_now
    and workspace.plan_id='creator_plus' and workspace.billing_catalog='2026-11-managed'
    and workspace.workspace_status='active' and workspace.billing_lifecycle->>'deletingAt' is null
    and p_monthly_microusd between 0 and 25000000
    and exists(select 1 from public.bento_instance_settings where edition='hosted')
  limit 1;
$$;
revoke all on function private.managed_provider_paid_subscription_period(uuid,text,timestamptz,bigint),
  private.managed_provider_paid_period(uuid,text,timestamptz,bigint) from public,anon,authenticated,service_role;

commit;
