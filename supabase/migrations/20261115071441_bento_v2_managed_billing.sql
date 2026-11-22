begin;

-- The entitlement tier is shared with Creator Plus. Only a verified new
-- contract can use the managed provider allowance.
alter table public.profiles drop constraint profiles_billing_catalog_check;
alter table public.profiles add constraint profiles_billing_catalog_check
  check (billing_catalog in ('legacy', '2026-10', '2026-11-managed'));
alter table public.subscriptions drop constraint subscriptions_billing_catalog_check;
alter table public.subscriptions add constraint subscriptions_billing_catalog_check
  check (billing_catalog in ('legacy', '2026-10', '2026-11-managed'));

create or replace function public.protect_hosted_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() in ('authenticated','anon') then
    if new.plan_id is distinct from old.plan_id or new.is_pro is distinct from old.is_pro
      or new.billing_catalog is distinct from old.billing_catalog
      or new.trial_ends_at is distinct from old.trial_ends_at
      or new.billing_lifecycle is distinct from old.billing_lifecycle then
      raise exception 'Billing access is managed by the server.';
    end if;
    if new.billing_catalog <> 'legacy' and new.onboarded and not old.onboarded then
      raise exception 'Complete verified onboarding activation first.';
    end if;
  end if;
  return new;
end;
$$;

-- Keep an in-flight recovery checkout bound to the product it was created for.
-- Reuse the existing workspace row lock and retention window.
alter table public.workspace_recovery_checkouts add column billing_product_id text;

create function public.reserve_workspace_checkout_for_product(p_workspace_id uuid, p_product_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  hold jsonb;
  hold_id uuid;
  saved_product text;
begin
  if nullif(p_product_id, '') is null then raise exception 'Checkout product is required.'; end if;
  hold := public.reserve_workspace_recovery_checkout(p_workspace_id);
  if hold is null then return null; end if;
  hold_id := (hold->>'id')::uuid;
  if hold->>'url' is null then
    update public.workspace_recovery_checkouts set billing_product_id = p_product_id where id = hold_id;
  else
    select billing_product_id into saved_product from public.workspace_recovery_checkouts where id = hold_id;
    if saved_product is distinct from p_product_id then
      raise exception 'A different recovery checkout is still within its payment window.';
    end if;
  end if;
  return hold;
end;
$$;
revoke all on function public.reserve_workspace_checkout_for_product(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_workspace_checkout_for_product(uuid, text) to service_role;

create table public.managed_provider_spend_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  weekly_microusd bigint not null default 7000000 check (weekly_microusd between 0 and 1000000000),
  monthly_microusd bigint not null default 30000000 check (monthly_microusd between 0 and 1000000000)
);
insert into public.managed_provider_spend_policy default values;

create table public.managed_provider_spend_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null,
  billing_payment_id text not null,
  resource text not null references public.provider_budget_policies(resource),
  provider text not null check (length(provider) between 1 and 64),
  model text not null check (length(model) between 1 and 120),
  reserved_microusd bigint not null check (reserved_microusd between 1 and 1000000),
  settled_microusd bigint check (settled_microusd between 0 and reserved_microusd),
  ai_reservation_id uuid references public.provider_ai_usage_reservations(id) on delete set null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (workspace_id, attempt_id)
);
create index managed_provider_spend_workspace_idx on public.managed_provider_spend_reservations(workspace_id, created_at);
create index managed_provider_spend_owner_idx on public.managed_provider_spend_reservations(owner_id, created_at);
create index managed_provider_spend_term_idx on public.managed_provider_spend_reservations(workspace_id, billing_payment_id);
create index managed_provider_spend_created_idx on public.managed_provider_spend_reservations(created_at);
create index managed_provider_spend_ai_idx on public.managed_provider_spend_reservations(ai_reservation_id)
  where ai_reservation_id is not null;

alter table public.managed_provider_spend_policy enable row level security;
alter table public.managed_provider_spend_reservations enable row level security;
revoke all on public.managed_provider_spend_policy, public.managed_provider_spend_reservations
  from public, anon, authenticated, service_role;
grant select, update on public.managed_provider_spend_policy to service_role;
grant select on public.managed_provider_spend_reservations to service_role;

insert into public.provider_budget_policies
  (resource, enabled, daily_limit, monthly_limit, workspace_daily_limit, workspace_monthly_limit)
values ('brave_search_requests', true, 200, 6000, 200, 6000);

-- Ownership fixes the account counter even when different members execute
-- tools. An explicit caller must also be an active member of this workspace.
create function private.managed_provider_workspace_owner(p_workspace_id uuid, p_auth_user_id uuid)
returns uuid language sql stable set search_path = '' as $$
  select m.auth_user_id
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id and m.role = 'owner' and m.status = 'active'
    and (p_auth_user_id is null or exists (
      select 1 from public.workspace_memberships caller
      where caller.workspace_id = p_workspace_id and caller.auth_user_id = p_auth_user_id
        and caller.status = 'active'
    ));
$$;

-- Signed Dodo payment events supply these fields. Settlement amount is the
-- balance credit after processing and currency conversion.
alter table public.payments
  add column dodo_charge_type text,
  add column billing_contract_catalog text,
  add column settlement_tax integer check (settlement_tax >= 0);

create function private.managed_provider_paid_period(
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

create function public.get_managed_provider_spend(
  p_workspace_id uuid, p_auth_user_id uuid, p_product_id text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  policy public.managed_provider_spend_policy%rowtype;
  account_id uuid;
  clock_now timestamptz := now();
  week_start timestamptz := date_trunc('week', clock_now, 'UTC');
  month_start timestamptz := date_trunc('month', clock_now, 'UTC');
  weekly_used bigint;
  monthly_used bigint;
  billing_used bigint;
  contract_payment_id text;
  contract_ends_at timestamptz;
begin
  account_id := private.managed_provider_workspace_owner(p_workspace_id, p_auth_user_id);
  if account_id is null then return jsonb_build_object('eligible', false, 'reason', 'ineligible'); end if;
  select * into policy from public.managed_provider_spend_policy;
  if not found or not policy.enabled then
    return jsonb_build_object('eligible', false, 'reason', 'unavailable');
  end if;
  select paid.payment_id, paid.ends_at into contract_payment_id, contract_ends_at
    from private.managed_provider_paid_period(p_workspace_id, p_product_id, clock_now, policy.monthly_microusd) paid;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'ineligible');
  end if;
  select
    greatest(
      coalesce(sum(coalesce(a.settled_microusd, a.reserved_microusd))
        filter (where a.created_at >= week_start and a.owner_id = account_id), 0),
      coalesce(sum(coalesce(a.settled_microusd, a.reserved_microusd))
        filter (where a.created_at >= week_start and a.workspace_id = p_workspace_id), 0)
    ),
    greatest(
      coalesce(sum(coalesce(a.settled_microusd, a.reserved_microusd))
        filter (where a.created_at >= month_start and a.owner_id = account_id), 0),
      coalesce(sum(coalesce(a.settled_microusd, a.reserved_microusd))
        filter (where a.created_at >= month_start and a.workspace_id = p_workspace_id), 0)
    )
  into weekly_used, monthly_used
  from public.managed_provider_spend_reservations a
  where (a.owner_id = account_id or a.workspace_id = p_workspace_id)
    and a.created_at >= least(week_start, month_start);
  select coalesce(sum(coalesce(a.settled_microusd, a.reserved_microusd)), 0) into billing_used
    from public.managed_provider_spend_reservations a
    where a.workspace_id = p_workspace_id and a.billing_payment_id = contract_payment_id;
  return jsonb_build_object('eligible', true, 'billingPaymentId', contract_payment_id,
    'billing', jsonb_build_object('limitMicrousd', policy.monthly_microusd,
      'remainingMicrousd', greatest(0, policy.monthly_microusd - billing_used),
      'resetsAt', contract_ends_at),
    'weekly', jsonb_build_object('limitMicrousd', policy.weekly_microusd,
      'remainingMicrousd', greatest(0, policy.weekly_microusd - weekly_used),
      'resetsAt', ((week_start at time zone 'UTC') + interval '1 week') at time zone 'UTC'),
    'monthly', jsonb_build_object('limitMicrousd', policy.monthly_microusd,
      'remainingMicrousd', greatest(0, policy.monthly_microusd - monthly_used),
      'resetsAt', ((month_start at time zone 'UTC') + interval '1 month') at time zone 'UTC'));
end;
$$;

create function public.reserve_managed_provider_usage(
  p_workspace_id uuid, p_auth_user_id uuid, p_product_id text, p_attempt_id uuid,
  p_resource text, p_provider_units bigint, p_microusd bigint, p_provider text, p_model text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account_id uuid;
  allowance jsonb;
  shared jsonb;
  ai_id uuid;
  receipt_id uuid;
  retry_at timestamptz;
  blocked_reason text;
begin
  if p_workspace_id is null or p_attempt_id is null or p_resource is null
    or p_provider_units is null or p_provider_units not between 1 and 1000000
    or p_microusd is null or p_microusd not between 1 and 1000000
    or p_provider is null or length(p_provider) not between 1 and 64
    or p_model is null or length(p_model) not between 1 and 120 then
    return jsonb_build_object('allowed', false, 'reason', 'unavailable');
  end if;
  account_id := private.managed_provider_workspace_owner(p_workspace_id, p_auth_user_id);
  if account_id is null then return jsonb_build_object('allowed', false, 'reason', 'ineligible'); end if;

  -- Lock the account first and workspace second in every managed write.
  perform pg_advisory_xact_lock(hashtextextended('bento-managed-account:' || account_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('bento-managed-workspace:' || p_workspace_id::text, 0));
  perform 1 from public.profiles where id = p_workspace_id for share;
  perform 1 from public.managed_provider_spend_policy for share;
  if private.managed_provider_workspace_owner(p_workspace_id, p_auth_user_id) is distinct from account_id then
    return jsonb_build_object('allowed', false, 'reason', 'ineligible');
  end if;
  if exists (select 1 from public.managed_provider_spend_reservations
    where workspace_id = p_workspace_id and attempt_id = p_attempt_id) then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_attempt');
  end if;
  allowance := public.get_managed_provider_spend(p_workspace_id, p_auth_user_id, p_product_id);
  if allowance->>'eligible' <> 'true' then
    return jsonb_build_object('allowed', false, 'reason', allowance->>'reason');
  end if;
  if p_microusd > (allowance #>> '{weekly,limitMicrousd}')::bigint
    or p_microusd > (allowance #>> '{monthly,limitMicrousd}')::bigint then
    return jsonb_build_object('allowed', false, 'reason', 'request_exceeds_limit');
  end if;
  if p_microusd > (allowance #>> '{weekly,remainingMicrousd}')::bigint then
    retry_at := (allowance #>> '{weekly,resetsAt}')::timestamptz;
    blocked_reason := 'managed_week';
  end if;
  if p_microusd > (allowance #>> '{monthly,remainingMicrousd}')::bigint
    and (retry_at is null or (allowance #>> '{monthly,resetsAt}')::timestamptz >= retry_at) then
    retry_at := (allowance #>> '{monthly,resetsAt}')::timestamptz;
    blocked_reason := 'managed_month';
  end if;
  if p_microusd > (allowance #>> '{billing,remainingMicrousd}')::bigint
    and (retry_at is null or (allowance #>> '{billing,resetsAt}')::timestamptz >= retry_at) then
    retry_at := (allowance #>> '{billing,resetsAt}')::timestamptz;
    blocked_reason := 'managed_billing_month';
  end if;
  if blocked_reason is not null then
    return jsonb_build_object('allowed', false, 'reason', blocked_reason, 'retry_at', retry_at);
  end if;

  if p_resource = 'ai_microusd' then
    if p_provider_units <> p_microusd then
      return jsonb_build_object('allowed', false, 'reason', 'unavailable');
    end if;
    -- Managed workspace/owner dollar allowances above replace the legacy AI
    -- workspace pool. The existing shared provider caps apply unchanged.
    shared := public.reserve_ai_provider_usage(p_provider_units, null, p_provider, p_model, false);
    if shared->>'allowed' <> 'true' then return shared; end if;
    ai_id := (shared->>'reservation_id')::uuid;
  elsif p_resource = 'public_ai_microusd'
    or (p_resource = 'brave_search_requests' and p_microusd < p_provider_units * 5000)
    or not public.reserve_provider_usage(p_resource, p_provider_units, p_workspace_id) then
    return jsonb_build_object('allowed', false, 'reason', 'unavailable');
  end if;

  insert into public.managed_provider_spend_reservations
    (workspace_id, owner_id, attempt_id, billing_payment_id, resource, provider, model, reserved_microusd, ai_reservation_id)
  values
    (p_workspace_id, account_id, p_attempt_id, allowance->>'billingPaymentId', p_resource, p_provider, p_model, p_microusd, ai_id)
  returning id into receipt_id;
  return jsonb_build_object('allowed', true, 'reservation_id', receipt_id);
end;
$$;

create function public.settle_managed_provider_usage(p_reservation_id uuid, p_actual_units bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  receipt public.managed_provider_spend_reservations%rowtype;
begin
  select * into receipt from public.managed_provider_spend_reservations where id = p_reservation_id;
  if not found or p_actual_units is null or p_actual_units not between 0 and receipt.reserved_microusd then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bento-managed-account:' || receipt.owner_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('bento-managed-workspace:' || receipt.workspace_id::text, 0));
  select * into receipt from public.managed_provider_spend_reservations where id = p_reservation_id for update;
  if not found then return false; end if;
  if receipt.settled_microusd is not null then return receipt.settled_microusd = p_actual_units; end if;
  if receipt.resource = 'ai_microusd' and
    (receipt.ai_reservation_id is null or not public.settle_ai_provider_usage(receipt.ai_reservation_id, p_actual_units)) then
    return false;
  end if;
  update public.managed_provider_spend_reservations
    set settled_microusd = p_actual_units, settled_at = now() where id = p_reservation_id;
  return true;
end;
$$;

revoke all on function private.managed_provider_workspace_owner(uuid, uuid),
  private.managed_provider_paid_period(uuid, text, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.get_managed_provider_spend(uuid, uuid, text),
  public.reserve_managed_provider_usage(uuid, uuid, text, uuid, text, bigint, bigint, text, text),
  public.settle_managed_provider_usage(uuid, bigint) from public, anon, authenticated;
grant execute on function public.get_managed_provider_spend(uuid, uuid, text),
  public.reserve_managed_provider_usage(uuid, uuid, text, uuid, text, bigint, bigint, text, text),
  public.settle_managed_provider_usage(uuid, bigint) to service_role;

create or replace function public.cleanup_provider_cost_data()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.managed_provider_spend_reservations where id in
    (select id from public.managed_provider_spend_reservations where created_at < now() - interval '100 days' limit 5000);
  delete from public.provider_ai_usage_reservations where id in
    (select id from public.provider_ai_usage_reservations where created_at < now() - interval '100 days' limit 5000);
  delete from public.provider_budget_workspace_allowances where (resource, workspace_id, period_start) in
    (select resource, workspace_id, period_start from public.provider_budget_workspace_allowances where period_start < current_date - 100 limit 5000);
  delete from public.provider_budget_usage where ctid in
    (select ctid from public.provider_budget_usage where period_start < current_date - 100 limit 5000);
  delete from public.social_mention_search_cache where ctid in
    (select ctid from public.social_mention_search_cache where expires_at < now() - interval '7 days' limit 1000);
  delete from public.social_preview_attempts where ctid in
    (select ctid from public.social_preview_attempts where created_at < now() - interval '30 days' limit 5000);
end;
$$;

notify pgrst, 'reload schema';
commit;
