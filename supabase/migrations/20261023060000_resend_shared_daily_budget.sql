-- One shared Resend budget for every email Bento sends.
--
-- Resend Free allows 100 emails per UTC calendar day and 3,000 per month for
-- the whole account. The old guard kept two separate pools in
-- provider_budget_policies (marketing 70, transactional 100), so together they
-- could reach 170 a day, and mail Resend counts that the worker never sees
-- (Supabase Auth SMTP, inbound mail) was not counted at all.
--
-- Now every worker send reserves one slot from a single daily and monthly
-- total before the provider call, under one row lock:
--   * marketing stops once the shared day total reaches marketing_daily_ceiling,
--   * transactional may use everything except auth_reserve,
--   * auth_reserve is never used by the worker, so Supabase Auth mail
--     (sign-in links, password resets) keeps room even on a busy day.
-- Resend's own x-resend-daily-quota / x-resend-monthly-quota headers are
-- recorded after each send, so mail sent outside the worker is counted too.
-- The old marketing_emails / transactional_emails policy rows are no longer
-- read for email and are left in place.

create table if not exists public.email_send_budget_policy (
  id boolean primary key default true check (id),
  daily_limit integer not null check (daily_limit between 0 and 100000),
  monthly_limit integer not null check (monthly_limit between 0 and 10000000),
  auth_reserve integer not null check (auth_reserve >= 0),
  marketing_daily_ceiling integer not null check (marketing_daily_ceiling >= 0),
  marketing_monthly_ceiling integer not null check (marketing_monthly_ceiling >= 0),
  check (auth_reserve <= daily_limit),
  check (marketing_daily_ceiling <= daily_limit - auth_reserve),
  check (marketing_monthly_ceiling <= monthly_limit - auth_reserve)
);

insert into public.email_send_budget_policy (
  id, daily_limit, monthly_limit, auth_reserve, marketing_daily_ceiling, marketing_monthly_ceiling
) values (true, 100, 3000, 10, 60, 2500)
on conflict (id) do nothing;

create table if not exists public.email_send_budget_usage (
  day date primary key,
  marketing integer not null default 0 check (marketing >= 0),
  transactional integer not null default 0 check (transactional >= 0),
  -- Emails Resend counted that the worker did not reserve (Auth SMTP, inbound).
  untracked_daily integer not null default 0 check (untracked_daily >= 0),
  untracked_monthly integer not null default 0 check (untracked_monthly >= 0),
  updated_at timestamptz not null default now()
);

alter table public.email_send_budget_policy enable row level security;
alter table public.email_send_budget_usage enable row level security;
revoke all on public.email_send_budget_policy, public.email_send_budget_usage
  from public, anon, authenticated;
grant select, update on public.email_send_budget_policy to service_role;
grant select on public.email_send_budget_usage to service_role;

-- Carry today's already-sent worker mail into the new counter so a deploy in
-- the middle of a UTC day does not reset the count.
insert into public.email_send_budget_usage (day, marketing, transactional)
select
  (outbox.sent_at at time zone 'utc')::date,
  count(*) filter (where outbox.category = 'marketing'),
  count(*) filter (where outbox.category = 'transactional')
from public.email_outbox outbox
where outbox.sent_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
group by 1
on conflict (day) do nothing;

create or replace function public.reserve_email_send(p_category text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy public.email_send_budget_policy%rowtype;
  today date := (now() at time zone 'utc')::date;
  month_start date := date_trunc('month', now() at time zone 'utc')::date;
  usage public.email_send_budget_usage%rowtype;
  day_used integer;
  month_used integer;
  day_cap integer;
  month_cap integer;
begin
  if p_category is null or p_category not in ('marketing', 'transactional') then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_category');
  end if;
  -- One short lock serializes every reservation across Worker instances,
  -- so concurrent batches cannot both read the same remaining count.
  select * into policy from public.email_send_budget_policy where id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'policy_missing');
  end if;

  insert into public.email_send_budget_usage (day) values (today) on conflict (day) do nothing;
  select * into usage from public.email_send_budget_usage where day = today;
  day_used := usage.marketing + usage.transactional + usage.untracked_daily;
  select coalesce(sum(row_usage.marketing + row_usage.transactional), 0)
    + coalesce(max(row_usage.untracked_monthly), 0)
  into month_used
  from public.email_send_budget_usage row_usage
  where row_usage.day >= month_start and row_usage.day <= today;

  if p_category = 'marketing' then
    day_cap := policy.marketing_daily_ceiling;
    month_cap := policy.marketing_monthly_ceiling;
  else
    day_cap := policy.daily_limit - policy.auth_reserve;
    month_cap := policy.monthly_limit - policy.auth_reserve;
  end if;

  if day_used >= day_cap then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily',
      'used', day_used,
      'cap', day_cap,
      'retry_at', ((today + 1)::timestamp at time zone 'utc')
    );
  end if;
  if month_used >= month_cap then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'monthly',
      'used', month_used,
      'cap', month_cap,
      'retry_at', ((month_start + interval '1 month')::timestamp at time zone 'utc')
    );
  end if;

  update public.email_send_budget_usage
  set marketing = marketing + case when p_category = 'marketing' then 1 else 0 end,
      transactional = transactional + case when p_category = 'transactional' then 1 else 0 end,
      updated_at = now()
  where day = today;

  return jsonb_build_object('allowed', true, 'used', day_used + 1, 'cap', day_cap);
end;
$$;

-- Resend reports the account's real usage, including mail the worker never
-- reserved. Keep the largest gap seen today so the shared total never runs low.
create or replace function public.record_resend_quota(p_daily_used integer, p_monthly_used integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (now() at time zone 'utc')::date;
  month_start date := date_trunc('month', now() at time zone 'utc')::date;
  month_reserved integer;
begin
  if p_daily_used is not null and (p_daily_used < 0 or p_daily_used > 100000) then return; end if;
  if p_monthly_used is not null and (p_monthly_used < 0 or p_monthly_used > 10000000) then return; end if;
  perform 1 from public.email_send_budget_policy where id for update;
  insert into public.email_send_budget_usage (day) values (today) on conflict (day) do nothing;
  select coalesce(sum(row_usage.marketing + row_usage.transactional), 0)
  into month_reserved
  from public.email_send_budget_usage row_usage
  where row_usage.day >= month_start and row_usage.day <= today;
  update public.email_send_budget_usage
  set untracked_daily = greatest(untracked_daily, p_daily_used - (marketing + transactional)),
      untracked_monthly = greatest(untracked_monthly, p_monthly_used - month_reserved),
      updated_at = now()
  where day = today;
end;
$$;

revoke all on function public.reserve_email_send(text) from public, anon, authenticated;
grant execute on function public.reserve_email_send(text) to service_role;
revoke all on function public.record_resend_quota(integer, integer) from public, anon, authenticated;
grant execute on function public.record_resend_quota(integer, integer) to service_role;

notify pgrst, 'reload schema';
