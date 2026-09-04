-- Keep one recent-user row per creator even when historical subscription rows
-- exist across providers. All referenced relations are schema-qualified so
-- SECURITY DEFINER functions can use an empty search path.
create or replace function public.get_founder_dashboard_database(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_days integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with payment_totals as (
    select upper(currency) as currency, sum(total_amount)::bigint as gross
    from public.payments where status = 'succeeded' group by upper(currency)
  ), refund_totals as (
    select upper(currency) as currency, sum(amount)::bigint as refunds
    from public.refunds where status = 'succeeded' group by upper(currency)
  ), mrr_totals as (
    select upper(coalesce(currency, 'USD')) as currency,
      sum(case billing_interval
        when 'month' then coalesce(amount, 0)
        when 'year' then round(coalesce(amount, 0)::numeric / 12)::bigint
        else 0 end)::bigint as mrr
    from public.subscriptions
    where status in ('active', 'trialing')
    group by upper(coalesce(currency, 'USD'))
  ), currencies as (
    select currency from payment_totals union select currency from refund_totals
    union select currency from mrr_totals
  ), all_revenue as (
    select currencies.currency, coalesce(payment_totals.gross, 0)::bigint as gross,
      coalesce(refund_totals.refunds, 0)::bigint as refunds,
      (coalesce(payment_totals.gross, 0) - coalesce(refund_totals.refunds, 0))::bigint as net,
      coalesce(mrr_totals.mrr, 0)::bigint as mrr
    from currencies
    left join payment_totals using (currency)
    left join refund_totals using (currency)
    left join mrr_totals using (currency)
  ), period_payments as (
    select upper(currency) as currency, sum(total_amount)::bigint as gross
    from public.payments
    where status = 'succeeded'
      and coalesce(occurred_at, created_at) >= p_period_start
      and coalesce(occurred_at, created_at) < p_period_end
    group by upper(currency)
  ), period_refunds as (
    select upper(currency) as currency, sum(amount)::bigint as refunds
    from public.refunds
    where status = 'succeeded'
      and coalesce(occurred_at, created_at) >= p_period_start
      and coalesce(occurred_at, created_at) < p_period_end
    group by upper(currency)
  ), period_currencies as (
    select currency from period_payments union select currency from period_refunds
  ), period_revenue as (
    select period_currencies.currency,
      coalesce(period_payments.gross, 0)::bigint as gross,
      coalesce(period_refunds.refunds, 0)::bigint as refunds,
      (coalesce(period_payments.gross, 0) - coalesce(period_refunds.refunds, 0))::bigint as net
    from period_currencies
    left join period_payments using (currency)
    left join period_refunds using (currency)
  ), chart_currency as (
    select coalesce((select currency from all_revenue order by net desc limit 1), 'USD') as currency
  ), series as (
    select generate_series(
      (p_period_end at time zone 'UTC')::date - greatest(p_days, 1),
      (p_period_end at time zone 'UTC')::date - 1,
      interval '1 day'
    )::date as day
  ), daily_signups as (
    select series.day,
      (select count(*) from public.profiles profile
       where profile.created_at >= series.day::timestamptz
         and profile.created_at < (series.day + 1)::timestamptz)::bigint as signups
    from series
  ), daily_revenue as (
    select series.day, chart_currency.currency,
      coalesce((select sum(payment.total_amount) from public.payments payment
        where payment.status = 'succeeded'
          and upper(payment.currency) = chart_currency.currency
          and coalesce(payment.occurred_at, payment.created_at) >= series.day::timestamptz
          and coalesce(payment.occurred_at, payment.created_at) < (series.day + 1)::timestamptz), 0)
      - coalesce((select sum(refund.amount) from public.refunds refund
        where refund.status = 'succeeded'
          and upper(refund.currency) = chart_currency.currency
          and coalesce(refund.occurred_at, refund.created_at) >= series.day::timestamptz
          and coalesce(refund.occurred_at, refund.created_at) < (series.day + 1)::timestamptz), 0)
      as revenue
    from series cross join chart_currency
  ), recent_users as (
    select profile.id, auth_user.email, profile.username,
      profile.display_name as display_name, profile.is_pro, profile.onboarded,
      profile.created_at, auth_user.last_sign_in_at,
      subscription.status::text as subscription_status,
      subscription.amount, subscription.currency
    from public.profiles profile
    join auth.users auth_user on auth_user.id = profile.id
    left join lateral (
      select candidate.status, candidate.amount, candidate.currency
      from public.subscriptions candidate
      where candidate.user_id = profile.id
      order by
        case when candidate.status::text in ('active', 'trialing', 'past_due') then 0 else 1 end,
        case candidate.plan_id when 'store' then 0 when 'link' then 1 else 2 end,
        candidate.updated_at desc
      limit 1
    ) subscription on true
    order by profile.created_at desc
    limit 100
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'users', (select count(*) from auth.users),
      'onboarded', (select count(*) from public.profiles where onboarded),
      'pro', (select count(*) from public.profiles where is_pro),
      'newUsers7d', (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
      'newUsersPeriod', (select count(*) from public.profiles
        where created_at >= p_period_start and created_at < p_period_end)
    ),
    'funnel', jsonb_build_array(
      jsonb_build_object('label', 'Signed up', 'value', (select count(*) from auth.users)),
      jsonb_build_object('label', 'Added a block', 'value',
        (select count(distinct user_id) from public.blocks)),
      jsonb_build_object('label', 'Completed onboarding', 'value',
        (select count(*) from public.profiles where onboarded)),
      jsonb_build_object('label', 'Upgraded to Pro', 'value',
        (select count(*) from public.profiles where is_pro))
    ),
    'activity', jsonb_build_object(
      'creatorActive7d', (select count(distinct user_id) from (
        select id as user_id from public.profiles where updated_at >= now() - interval '7 days'
        union select user_id from public.blocks where updated_at >= now() - interval '7 days'
        union select user_id from public.pages where updated_at >= now() - interval '7 days'
      ) active),
      'creatorActive30d', (select count(distinct user_id) from (
        select id as user_id from public.profiles where updated_at >= now() - interval '30 days'
        union select user_id from public.blocks where updated_at >= now() - interval '30 days'
        union select user_id from public.pages where updated_at >= now() - interval '30 days'
      ) active),
      'pagesWithVisitors7d', (select count(distinct user_id) from public.analytics_daily
        where day >= current_date - 6 and views > 0),
      'pagesWithVisitors30d', (select count(distinct user_id) from public.analytics_daily
        where day >= current_date - 29 and views > 0)
    ),
    'revenue', coalesce((select jsonb_agg(jsonb_build_object(
      'currency', currency, 'gross', gross, 'refunds', refunds, 'net', net, 'mrr', mrr
    ) order by net desc) from all_revenue), '[]'::jsonb),
    'periodRevenue', coalesce((select jsonb_agg(jsonb_build_object(
      'currency', currency, 'gross', gross, 'refunds', refunds, 'net', net
    ) order by net desc) from period_revenue), '[]'::jsonb),
    'dailySignups', coalesce((select jsonb_agg(jsonb_build_object(
      'date', day, 'signups', signups) order by day) from daily_signups), '[]'::jsonb),
    'dailyRevenue', coalesce((select jsonb_agg(jsonb_build_object(
      'date', day, 'revenue', revenue, 'currency', currency) order by day) from daily_revenue),
      '[]'::jsonb),
    'recentUsers', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'email', email, 'username', username, 'displayName', display_name,
      'isPro', is_pro, 'onboarded', onboarded, 'createdAt', created_at,
      'lastSignInAt', last_sign_in_at, 'subscriptionStatus', subscription_status,
      'amount', amount, 'currency', currency) order by created_at desc) from recent_users),
      '[]'::jsonb)
  );
$$;

-- Prefer the highest active paid entitlement when complimentary access is
-- granted or revoked; a newer Link row must not mask an older active Store row.
create or replace function public.grant_complimentary_plan(
  p_email text,
  p_plan_id text,
  p_granted_by uuid
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

create or replace function public.revoke_complimentary_plan(
  p_grant_id uuid
)
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

alter function public.get_founder_journey_context(uuid[], text) set search_path = '';
alter function public.get_founder_complimentary_plan_grants() set search_path = '';

revoke all on function public.get_founder_dashboard_database(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.get_founder_journey_context(uuid[], text)
  from public, anon, authenticated;
revoke all on function public.get_founder_complimentary_plan_grants()
  from public, anon, authenticated;
revoke all on function public.grant_complimentary_plan(text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_complimentary_plan(uuid)
  from public, anon, authenticated;

grant execute on function public.get_founder_dashboard_database(timestamptz, timestamptz, integer)
  to service_role;
grant execute on function public.get_founder_journey_context(uuid[], text) to service_role;
grant execute on function public.get_founder_complimentary_plan_grants() to service_role;
grant execute on function public.grant_complimentary_plan(text, text, uuid) to service_role;
grant execute on function public.revoke_complimentary_plan(uuid) to service_role;

notify pgrst, 'reload schema';
