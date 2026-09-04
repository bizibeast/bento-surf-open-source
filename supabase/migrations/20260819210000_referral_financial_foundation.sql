-- Native Bento referral attribution and financial ledger. All money is stored
-- in provider minor units; all mutation RPCs are service-role only.

create table public.referral_program_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  commission_rate_bps integer not null default 2000 check (commission_rate_bps between 0 and 10000),
  attribution_window_days integer not null default 30 check (attribution_window_days between 1 and 365),
  commission_hold_days integer not null default 30 check (commission_hold_days between 0 and 365),
  payout_minimums jsonb not null default '{"USD":5000}'::jsonb,
  reach_rates jsonb not null default '{"twitter":1000,"linkedin":2500,"instagram":500,"threads":500}'::jsonb,
  reach_cap integer not null default 50000 check (reach_cap >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.referral_program_settings(id) values (true) on conflict do nothing;

create table public.referral_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  code text not null unique,
  status text not null default 'active' check (status in ('active', 'suspended')),
  commission_rate_bps integer check (commission_rate_bps between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_accounts_code_check check (
    code = lower(code)
    and code ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$'
    and code not in ('admin', 'api', 'dashboard', 'earn', 'home', 'login', 'onboarding', 'r', 'settings', 'signup')
  )
);

create table public.referral_clicks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.referral_accounts(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  visitor_hash text,
  user_agent_family text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.referral_attributions (
  id uuid primary key default gen_random_uuid(),
  referred_user_id uuid not null unique references auth.users(id) on delete restrict,
  account_id uuid not null references public.referral_accounts(id) on delete restrict,
  click_id uuid not null references public.referral_clicks(id) on delete restrict,
  attributed_at timestamptz not null default now(),
  first_paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.referral_payouts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.referral_accounts(id) on delete restrict,
  currency text not null check (currency = upper(currency) and length(currency) = 3),
  amount integer not null check (amount >= 0),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'processing', 'paid', 'rejected', 'failed')),
  method text,
  provider_reference text,
  notes text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  processed_at timestamptz,
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.referral_payment_effects (
  payment_id text primary key references public.payments(payment_id) on delete restrict,
  eligible boolean not null,
  reason text not null,
  attribution_id uuid references public.referral_attributions(id) on delete restrict,
  commission_rate_bps integer check (commission_rate_bps between 0 and 10000),
  commission_base integer check (commission_base >= 0),
  currency text check (currency = upper(currency) and length(currency) = 3),
  amount integer check (amount >= 0),
  occurred_at timestamptz,
  available_at timestamptz,
  created_at timestamptz not null default now(),
  constraint referral_payment_effect_snapshot_check check (
    not eligible or (
      attribution_id is not null and commission_rate_bps is not null and
      commission_base is not null and currency is not null and
      amount is not null and occurred_at is not null and available_at is not null
    )
  )
);

create table public.referral_commissions (
  id uuid primary key default gen_random_uuid(),
  attribution_id uuid not null references public.referral_attributions(id) on delete restrict,
  payment_id text not null unique references public.payments(payment_id) on delete restrict,
  commission_rate_bps integer not null check (commission_rate_bps between 0 and 10000),
  commission_base integer not null check (commission_base >= 0),
  currency text not null check (currency = upper(currency) and length(currency) = 3),
  amount integer not null check (amount >= 0),
  reversed_amount integer not null default 0 check (reversed_amount >= 0 and reversed_amount <= amount),
  status text not null default 'pending'
    check (status in ('pending', 'available', 'included_in_payout', 'paid', 'reversed')),
  available_at timestamptz not null,
  payout_id uuid references public.referral_payouts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.referral_commission_adjustments (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.referral_commissions(id) on delete restrict,
  refund_id text not null unique references public.refunds(refund_id) on delete restrict,
  amount integer not null check (amount > 0),
  currency text not null check (currency = upper(currency) and length(currency) = 3),
  offset_required boolean not null default false,
  payout_id uuid references public.referral_payouts(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.referral_reach_submissions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.referral_accounts(id) on delete cascade,
  connection_id uuid not null references public.social_connections(id) on delete cascade,
  provider text not null check (provider in ('twitter', 'linkedin', 'instagram', 'threads')),
  canonical_post_url text not null unique,
  referral_url_snapshot text not null,
  status text not null default 'submitted'
    check (status in ('submitted', 'verifying', 'eligible', 'measuring', 'review', 'approved', 'included_in_payout', 'paid', 'rejected')),
  baseline_views bigint check (baseline_views is null or baseline_views >= 0),
  final_views bigint check (final_views is null or final_views >= 0),
  reward_amount integer check (reward_amount is null or reward_amount >= 0),
  rate_per_10k integer not null check (rate_per_10k >= 0),
  reward_cap integer not null check (reward_cap >= 0),
  currency text not null default 'USD' check (currency = upper(currency) and length(currency) = 3),
  provider_snapshot jsonb not null default '{}'::jsonb,
  eligible_at timestamptz,
  measure_after timestamptz,
  reviewed_at timestamptz,
  rejection_reason text,
  payout_id uuid references public.referral_payouts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.referral_admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index referral_clicks_account_created_idx on public.referral_clicks(account_id, created_at desc);
create index referral_clicks_expiry_idx on public.referral_clicks(expires_at);
create index referral_attributions_account_idx on public.referral_attributions(account_id, attributed_at desc);
create index referral_commissions_attribution_idx on public.referral_commissions(attribution_id, created_at desc);
create index referral_commissions_payout_idx on public.referral_commissions(payout_id) where payout_id is not null;
create index referral_commissions_available_idx on public.referral_commissions(status, available_at) where payout_id is null;
create index referral_adjustments_commission_idx on public.referral_commission_adjustments(commission_id);
create index referral_adjustments_payout_idx on public.referral_commission_adjustments(payout_id) where payout_id is not null;
create index referral_payouts_account_idx on public.referral_payouts(account_id, requested_at desc);
create index referral_reach_account_idx on public.referral_reach_submissions(account_id, created_at desc);
create index referral_reach_connection_idx on public.referral_reach_submissions(connection_id, created_at desc);
create index referral_admin_audit_idx on public.referral_admin_audit_events(created_at desc);

alter table public.referral_program_settings enable row level security;
alter table public.referral_accounts enable row level security;
alter table public.referral_clicks enable row level security;
alter table public.referral_attributions enable row level security;
alter table public.referral_payment_effects enable row level security;
alter table public.referral_commissions enable row level security;
alter table public.referral_commission_adjustments enable row level security;
alter table public.referral_payouts enable row level security;
alter table public.referral_reach_submissions enable row level security;
alter table public.referral_admin_audit_events enable row level security;

revoke all on public.referral_program_settings from anon, authenticated;
revoke all on public.referral_accounts from anon, authenticated;
revoke all on public.referral_clicks from anon, authenticated;
revoke all on public.referral_attributions from anon, authenticated;
revoke all on public.referral_payment_effects from anon, authenticated;
revoke all on public.referral_commissions from anon, authenticated;
revoke all on public.referral_commission_adjustments from anon, authenticated;
revoke all on public.referral_payouts from anon, authenticated;
revoke all on public.referral_reach_submissions from anon, authenticated;
revoke all on public.referral_admin_audit_events from anon, authenticated;

grant all on public.referral_program_settings, public.referral_accounts, public.referral_clicks,
  public.referral_attributions, public.referral_commissions, public.referral_commission_adjustments,
  public.referral_payouts, public.referral_reach_submissions, public.referral_admin_audit_events
  to service_role;

create policy referral_accounts_owner_read on public.referral_accounts for select to authenticated
  using (user_id = (select auth.uid()));
create policy referral_clicks_owner_read on public.referral_clicks for select to authenticated
  using (account_id in (select id from public.referral_accounts where user_id = (select auth.uid())));
create policy referral_attributions_owner_read on public.referral_attributions for select to authenticated
  using (account_id in (select id from public.referral_accounts where user_id = (select auth.uid())));
create policy referral_commissions_owner_read on public.referral_commissions for select to authenticated
  using (attribution_id in (
    select a.id from public.referral_attributions a join public.referral_accounts r on r.id = a.account_id
    where r.user_id = (select auth.uid())
  ));
create policy referral_adjustments_owner_read on public.referral_commission_adjustments for select to authenticated
  using (commission_id in (
    select c.id from public.referral_commissions c
    join public.referral_attributions a on a.id = c.attribution_id
    join public.referral_accounts r on r.id = a.account_id where r.user_id = (select auth.uid())
  ));
create policy referral_payouts_owner_read on public.referral_payouts for select to authenticated
  using (account_id in (select id from public.referral_accounts where user_id = (select auth.uid())));
create policy referral_reach_owner_read on public.referral_reach_submissions for select to authenticated
  using (account_id in (select id from public.referral_accounts where user_id = (select auth.uid())));

create trigger referral_program_settings_updated_at before update on public.referral_program_settings
  for each row execute function public.tg_set_updated_at();
create trigger referral_accounts_updated_at before update on public.referral_accounts
  for each row execute function public.tg_set_updated_at();
create trigger referral_commissions_updated_at before update on public.referral_commissions
  for each row execute function public.tg_set_updated_at();
create trigger referral_payouts_updated_at before update on public.referral_payouts
  for each row execute function public.tg_set_updated_at();
create trigger referral_reach_updated_at before update on public.referral_reach_submissions
  for each row execute function public.tg_set_updated_at();

create or replace function public.prevent_referral_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Referral audit events are append-only';
end;
$$;

create trigger referral_admin_audit_immutable
  before update or delete on public.referral_admin_audit_events
  for each row execute function public.prevent_referral_audit_mutation();

create or replace function public.consume_referral_click(p_token_hash text, p_referred_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  click_row public.referral_clicks%rowtype;
  attribution_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  if exists(select 1 from public.referral_attributions where referred_user_id = p_referred_user_id) then
    return null;
  end if;
  if exists(select 1 from public.payments where user_id = p_referred_user_id and status in ('succeeded', 'paid', 'completed'))
     or exists(select 1 from public.subscriptions where user_id = p_referred_user_id and status in ('active', 'trialing')) then
    return null;
  end if;
  select c.* into click_row from public.referral_clicks c
    join public.referral_accounts a on a.id = c.account_id
    where c.token_hash = p_token_hash and c.expires_at > now() and a.status = 'active'
    for update of c;
  if click_row.id is null then return null; end if;
  if exists(select 1 from public.referral_accounts where id = click_row.account_id and user_id = p_referred_user_id) then
    return null;
  end if;
  insert into public.referral_attributions(referred_user_id, account_id, click_id)
  values (p_referred_user_id, click_row.account_id, click_row.id)
  on conflict do nothing returning id into attribution_id;
  return attribution_id;
end;
$$;

create or replace function public.accrue_referral_commission(p_payment_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  payment_row public.payments%rowtype;
  attribution_row public.referral_attributions%rowtype;
  settings_row public.referral_program_settings%rowtype;
  account_rate integer;
  base_amount integer;
  result_id uuid;
begin
  select * into payment_row from public.payments where payment_id = p_payment_id for update;
  if payment_row.payment_id is null or payment_row.status not in ('succeeded', 'paid', 'completed') then return null; end if;
  select * into attribution_row from public.referral_attributions where referred_user_id = payment_row.user_id;
  if attribution_row.id is null then return null; end if;
  select * into settings_row from public.referral_program_settings where id = true;
  if not settings_row.enabled then return null; end if;
  select commission_rate_bps into account_rate from public.referral_accounts
    where id = attribution_row.account_id and status = 'active';
  if not found then return null; end if;
  account_rate := coalesce(account_rate, settings_row.commission_rate_bps);
  base_amount := greatest(0, payment_row.total_amount - coalesce(payment_row.tax, 0));
  insert into public.referral_commissions(
    attribution_id, payment_id, commission_rate_bps, commission_base, currency,
    amount, available_at
  ) values (
    attribution_row.id, payment_row.payment_id, account_rate, base_amount,
    upper(payment_row.currency), floor(base_amount::numeric * account_rate / 10000)::integer,
    coalesce(payment_row.occurred_at, payment_row.created_at) + make_interval(days => settings_row.commission_hold_days)
  ) on conflict do nothing returning id into result_id;
  if result_id is not null then
    update public.referral_attributions set first_paid_at = coalesce(first_paid_at, coalesce(payment_row.occurred_at, now()))
      where id = attribution_row.id;
  end if;
  return result_id;
end;
$$;

create or replace function public.apply_referral_refund(p_refund_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  refund_row public.refunds%rowtype;
  commission_row public.referral_commissions%rowtype;
  payment_total integer;
  adjustment integer;
  result_id uuid;
begin
  select * into refund_row from public.refunds where refund_id = p_refund_id and status in ('succeeded', 'paid', 'completed') for update;
  if refund_row.refund_id is null then return null; end if;
  select c.* into commission_row from public.referral_commissions c
    where c.payment_id = refund_row.payment_id for update;
  if commission_row.id is null then return null; end if;
  select total_amount into payment_total from public.payments where payment_id = refund_row.payment_id;
  adjustment := least(
    commission_row.amount - commission_row.reversed_amount,
    floor(commission_row.amount::numeric * refund_row.amount / greatest(payment_total, 1))::integer
  );
  if adjustment <= 0 then return null; end if;
  insert into public.referral_commission_adjustments(commission_id, refund_id, amount, currency, offset_required)
    values (commission_row.id, refund_row.refund_id, adjustment, commission_row.currency, commission_row.status = 'paid')
    on conflict do nothing returning id into result_id;
  if result_id is not null then
    update public.referral_commissions set
      reversed_amount = reversed_amount + adjustment,
      status = case when reversed_amount + adjustment >= amount then 'reversed' else status end
    where id = commission_row.id;
    if commission_row.payout_id is not null and commission_row.status = 'included_in_payout' then
      update public.referral_payouts set
        amount = greatest(0, amount - adjustment),
        status = case when amount - adjustment <= 0 then 'rejected' else status end,
        notes = case when amount - adjustment <= 0 then 'Automatically closed after a full refund.' else notes end
        where id = commission_row.payout_id and status in ('requested', 'approved', 'processing');
    end if;
  end if;
  return result_id;
end;
$$;

create or replace function public.request_referral_payout(p_user_id uuid, p_currency text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  account_row public.referral_accounts%rowtype;
  normalized_currency text := upper(trim(p_currency));
  minimum_amount integer;
  commission_total integer := 0;
  reach_total integer := 0;
  adjustment_total integer := 0;
  total_amount integer := 0;
  commission_ids uuid[] := '{}';
  reach_ids uuid[] := '{}';
  adjustment_ids uuid[] := '{}';
  v_payout_id uuid;
begin
  select * into account_row from public.referral_accounts where user_id = p_user_id and status = 'active' for update;
  if account_row.id is null then raise exception 'Referral account is not active'; end if;
  select (payout_minimums->>normalized_currency)::integer into minimum_amount
    from public.referral_program_settings where id = true and enabled;
  if minimum_amount is null then raise exception 'Payout currency is not configured'; end if;
  update public.referral_commissions set status = 'available'
    where attribution_id in (select id from public.referral_attributions where account_id = account_row.id)
      and status = 'pending' and available_at <= now() and reversed_amount < amount;
  with claimable as (
    select id, amount, reversed_amount from public.referral_commissions
    where attribution_id in (select id from public.referral_attributions where account_id = account_row.id)
      and currency = normalized_currency and status = 'available' and payout_id is null
    for update skip locked
  )
  select coalesce(array_agg(id), '{}'), coalesce(sum(amount - reversed_amount), 0)
    into commission_ids, commission_total from claimable;
  with claimable as (
    select id, reward_amount from public.referral_reach_submissions
    where account_id = account_row.id and currency = normalized_currency
      and status = 'approved' and payout_id is null
    for update skip locked
  )
  select coalesce(array_agg(id), '{}'), coalesce(sum(reward_amount), 0)
    into reach_ids, reach_total from claimable;
  with claimable as (
    select a.id, a.amount from public.referral_commission_adjustments a
    join public.referral_commissions c on c.id = a.commission_id
    join public.referral_attributions t on t.id = c.attribution_id
    where t.account_id = account_row.id and a.currency = normalized_currency
      and a.offset_required and a.payout_id is null
    for update of a skip locked
  )
  select coalesce(array_agg(id), '{}'), coalesce(sum(amount), 0)
    into adjustment_ids, adjustment_total from claimable;
  total_amount := commission_total + reach_total - adjustment_total;
  if total_amount < minimum_amount then raise exception 'Minimum payout has not been reached'; end if;
  insert into public.referral_payouts(account_id, currency, amount)
    values (account_row.id, normalized_currency, total_amount) returning id into v_payout_id;
  update public.referral_commissions set payout_id = v_payout_id, status = 'included_in_payout'
    where id = any(commission_ids);
  update public.referral_reach_submissions set payout_id = v_payout_id, status = 'included_in_payout'
    where id = any(reach_ids);
  update public.referral_commission_adjustments set payout_id = v_payout_id
    where id = any(adjustment_ids);
  return v_payout_id;
end;
$$;

create or replace function public.admin_set_referral_account_status(
  p_admin_user_id uuid, p_account_id uuid, p_status text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare before_row public.referral_accounts%rowtype; after_row public.referral_accounts%rowtype;
begin
  if p_status not in ('active', 'suspended') then raise exception 'Invalid referral account status'; end if;
  select * into before_row from public.referral_accounts where id = p_account_id for update;
  if before_row.id is null then raise exception 'Referral account not found'; end if;
  update public.referral_accounts set status = p_status where id = p_account_id returning * into after_row;
  insert into public.referral_admin_audit_events(admin_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_admin_user_id, 'referral_account_status_changed', 'referral_account', p_account_id::text, to_jsonb(before_row), to_jsonb(after_row));
  return to_jsonb(after_row);
end;
$$;

create or replace function public.admin_set_referral_account_rate(
  p_admin_user_id uuid, p_account_id uuid, p_commission_rate_bps integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare before_row public.referral_accounts%rowtype; after_row public.referral_accounts%rowtype;
begin
  if p_commission_rate_bps is not null and p_commission_rate_bps not between 0 and 10000 then
    raise exception 'Invalid commission rate';
  end if;
  select * into before_row from public.referral_accounts where id = p_account_id for update;
  if before_row.id is null then raise exception 'Referral account not found'; end if;
  update public.referral_accounts set commission_rate_bps = p_commission_rate_bps
    where id = p_account_id returning * into after_row;
  insert into public.referral_admin_audit_events(admin_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_admin_user_id, 'referral_account_rate_changed', 'referral_account', p_account_id::text, to_jsonb(before_row), to_jsonb(after_row));
  return to_jsonb(after_row);
end;
$$;

create or replace function public.admin_transition_referral_payout(
  p_admin_user_id uuid, p_payout_id uuid, p_status text, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare before_row public.referral_payouts%rowtype; after_row public.referral_payouts%rowtype; transition_allowed boolean;
begin
  select * into before_row from public.referral_payouts where id = p_payout_id for update;
  if before_row.id is null then raise exception 'Referral payout not found'; end if;
  transition_allowed :=
    (before_row.status = 'requested' and p_status in ('approved', 'rejected')) or
    (before_row.status = 'approved' and p_status in ('processing', 'rejected')) or
    (before_row.status = 'processing' and p_status in ('paid', 'failed'));
  if not transition_allowed then raise exception 'That payout transition is not allowed'; end if;
  if p_status = 'paid' and nullif(trim(p_reference), '') is null then
    raise exception 'Transfer reference is required';
  end if;
  update public.referral_payouts set
    status = p_status,
    provider_reference = coalesce(nullif(trim(p_reference), ''), provider_reference),
    approved_at = case when p_status = 'approved' then now() else approved_at end,
    processed_at = case when p_status = 'processing' then now() else processed_at end,
    paid_at = case when p_status = 'paid' then now() else paid_at end
  where id = p_payout_id returning * into after_row;
  if p_status = 'paid' then
    update public.referral_commissions set status = 'paid'
      where payout_id = p_payout_id and status = 'included_in_payout';
    update public.referral_reach_submissions set status = 'paid'
      where payout_id = p_payout_id and status = 'included_in_payout';
  elsif p_status in ('rejected', 'failed') then
    update public.referral_commissions set status = 'available', payout_id = null
      where payout_id = p_payout_id and status = 'included_in_payout';
    update public.referral_reach_submissions set status = 'approved', payout_id = null
      where payout_id = p_payout_id and status = 'included_in_payout';
    update public.referral_commission_adjustments set payout_id = null where payout_id = p_payout_id;
  end if;
  insert into public.referral_admin_audit_events(admin_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_admin_user_id, 'referral_payout_status_changed', 'referral_payout', p_payout_id::text, to_jsonb(before_row), to_jsonb(after_row));
  return to_jsonb(after_row);
end;
$$;

create or replace function public.admin_review_referral_reach(
  p_admin_user_id uuid, p_submission_id uuid, p_decision text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare before_row public.referral_reach_submissions%rowtype; after_row public.referral_reach_submissions%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'Invalid reach decision'; end if;
  select * into before_row from public.referral_reach_submissions where id = p_submission_id for update;
  if before_row.id is null or before_row.status not in ('review', 'verifying', 'measuring') then
    raise exception 'That submission is not ready for review';
  end if;
  if p_decision = 'approved' and before_row.reward_amount is null then
    raise exception 'Verify the view count before approving this reward';
  end if;
  if p_decision = 'approved' and (
    not exists(select 1 from public.referral_accounts where id = before_row.account_id and status = 'active')
    or not exists(select 1 from public.referral_program_settings where id = true and enabled)
  ) then
    raise exception 'This referral account or program is not active';
  end if;
  update public.referral_reach_submissions set
    status = p_decision,
    reviewed_at = now(),
    rejection_reason = case when p_decision = 'rejected' then coalesce(nullif(trim(p_reason), ''), 'Not eligible') else null end
  where id = p_submission_id returning * into after_row;
  insert into public.referral_admin_audit_events(admin_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_admin_user_id, 'referral_reach_' || p_decision, 'referral_reach_submission', p_submission_id::text, to_jsonb(before_row), to_jsonb(after_row));
  return to_jsonb(after_row);
end;
$$;

create or replace function public.admin_update_referral_settings(
  p_admin_user_id uuid,
  p_enabled boolean,
  p_commission_rate_bps integer,
  p_attribution_window_days integer,
  p_commission_hold_days integer,
  p_payout_minimums jsonb,
  p_reach_rates jsonb,
  p_reach_cap integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare before_row public.referral_program_settings%rowtype; after_row public.referral_program_settings%rowtype;
begin
  if p_commission_rate_bps not between 0 and 10000
    or p_attribution_window_days not between 1 and 365
    or p_commission_hold_days not between 0 and 365
    or p_reach_cap < 0 then raise exception 'Invalid referral program settings'; end if;
  select * into before_row from public.referral_program_settings where id = true for update;
  update public.referral_program_settings set
    enabled = p_enabled,
    commission_rate_bps = p_commission_rate_bps,
    attribution_window_days = p_attribution_window_days,
    commission_hold_days = p_commission_hold_days,
    payout_minimums = p_payout_minimums,
    reach_rates = p_reach_rates,
    reach_cap = p_reach_cap,
    updated_by = p_admin_user_id
  where id = true returning * into after_row;
  insert into public.referral_admin_audit_events(admin_user_id, action, entity_type, entity_id, before_state, after_state)
    values (p_admin_user_id, 'referral_settings_changed', 'referral_program', 'default', to_jsonb(before_row), to_jsonb(after_row));
  return to_jsonb(after_row);
end;
$$;

-- Reconciliation only materializes immutable payment decisions captured by the webhook.
create or replace function public.accrue_referral_commission(p_payment_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  effect_row public.referral_payment_effects%rowtype;
  result_id uuid;
begin
  select * into effect_row from public.referral_payment_effects
    where payment_id = p_payment_id for update;
  if effect_row.payment_id is null or not effect_row.eligible then return null; end if;
  insert into public.referral_commissions(
    attribution_id, payment_id, commission_rate_bps, commission_base, currency, amount, available_at
  ) values (
    effect_row.attribution_id, effect_row.payment_id, effect_row.commission_rate_bps,
    effect_row.commission_base, effect_row.currency, effect_row.amount, effect_row.available_at
  ) on conflict do nothing returning id into result_id;
  if result_id is not null then
    update public.referral_attributions set first_paid_at = coalesce(first_paid_at, effect_row.occurred_at)
      where id = effect_row.attribution_id;
  end if;
  return result_id;
end;
$$;

create or replace function public.record_referral_payment_effect(
  p_payment_id text, p_product_eligible boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  payment_row public.payments%rowtype;
  attribution_row public.referral_attributions%rowtype;
  settings_row public.referral_program_settings%rowtype;
  account_rate integer;
  base_amount integer;
  occurred_at timestamptz;
begin
  select * into payment_row from public.payments where payment_id = p_payment_id for update;
  if payment_row.payment_id is null or payment_row.status not in ('succeeded', 'paid', 'completed') then
    return null;
  end if;
  if not coalesce(p_product_eligible, false) then
    insert into public.referral_payment_effects(payment_id, eligible, reason)
      values (p_payment_id, false, 'product_ineligible') on conflict do nothing;
    return null;
  end if;
  select * into attribution_row from public.referral_attributions
    where referred_user_id = payment_row.user_id;
  if attribution_row.id is null then
    insert into public.referral_payment_effects(payment_id, eligible, reason)
      values (p_payment_id, false, 'no_attribution') on conflict do nothing;
    return null;
  end if;
  select * into settings_row from public.referral_program_settings where id = true;
  if not settings_row.enabled then
    insert into public.referral_payment_effects(payment_id, eligible, reason)
      values (p_payment_id, false, 'program_disabled') on conflict do nothing;
    return null;
  end if;
  select commission_rate_bps into account_rate from public.referral_accounts
    where id = attribution_row.account_id and status = 'active';
  if not found then
    insert into public.referral_payment_effects(payment_id, eligible, reason)
      values (p_payment_id, false, 'account_inactive') on conflict do nothing;
    return null;
  end if;
  account_rate := coalesce(account_rate, settings_row.commission_rate_bps);
  base_amount := greatest(0, payment_row.total_amount - coalesce(payment_row.tax, 0));
  occurred_at := coalesce(payment_row.occurred_at, payment_row.created_at);
  insert into public.referral_payment_effects(
    payment_id, eligible, reason, attribution_id, commission_rate_bps,
    commission_base, currency, amount, occurred_at, available_at
  ) values (
    payment_row.payment_id, true, 'eligible', attribution_row.id, account_rate,
    base_amount, upper(payment_row.currency),
    floor(base_amount::numeric * account_rate / 10000)::integer,
    occurred_at, occurred_at + make_interval(days => settings_row.commission_hold_days)
  ) on conflict do nothing;
  return public.accrue_referral_commission(p_payment_id);
end;
$$;

revoke all on function public.consume_referral_click(text, uuid) from public, anon, authenticated;
revoke all on function public.record_referral_payment_effect(text, boolean) from public, anon, authenticated;
revoke all on function public.accrue_referral_commission(text) from public, anon, authenticated;
revoke all on function public.apply_referral_refund(text) from public, anon, authenticated;
revoke all on function public.request_referral_payout(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_set_referral_account_status(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_set_referral_account_rate(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_transition_referral_payout(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_review_referral_reach(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_update_referral_settings(uuid, boolean, integer, integer, integer, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.prevent_referral_audit_mutation() from public, anon, authenticated;
grant execute on function public.consume_referral_click(text, uuid) to service_role;
grant execute on function public.record_referral_payment_effect(text, boolean) to service_role;
grant execute on function public.accrue_referral_commission(text) to service_role;
grant execute on function public.apply_referral_refund(text) to service_role;
grant execute on function public.request_referral_payout(uuid, text) to service_role;
grant execute on function public.admin_set_referral_account_status(uuid, uuid, text) to service_role;
grant execute on function public.admin_set_referral_account_rate(uuid, uuid, integer) to service_role;
grant execute on function public.admin_transition_referral_payout(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_review_referral_reach(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_update_referral_settings(uuid, boolean, integer, integer, integer, jsonb, jsonb, integer) to service_role;
