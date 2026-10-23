-- Calendar-day reports, exact operational counts, and paid-only MRR.
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
    where status = 'active'
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
      (p_period_start at time zone 'UTC')::date,
      ((p_period_end - interval '1 microsecond') at time zone 'UTC')::date,
      interval '1 day'
    )::date as day
  ), daily_signups as (
    select series.day,
      (select count(*) from public.profiles profile
       where profile.created_at >= greatest((series.day::timestamp at time zone 'UTC'), p_period_start)
         and profile.created_at < least(((series.day + 1)::timestamp at time zone 'UTC'), p_period_end))::bigint as signups
    from series
  ), daily_revenue as (
    select series.day, chart_currency.currency,
      coalesce((select sum(payment.total_amount) from public.payments payment
        where payment.status = 'succeeded'
          and upper(payment.currency) = chart_currency.currency
          and coalesce(payment.occurred_at, payment.created_at) >= greatest((series.day::timestamp at time zone 'UTC'), p_period_start)
          and coalesce(payment.occurred_at, payment.created_at) < least(((series.day + 1)::timestamp at time zone 'UTC'), p_period_end)), 0)
      - coalesce((select sum(refund.amount) from public.refunds refund
        where refund.status = 'succeeded'
          and upper(refund.currency) = chart_currency.currency
          and coalesce(refund.occurred_at, refund.created_at) >= greatest((series.day::timestamp at time zone 'UTC'), p_period_start)
          and coalesce(refund.occurred_at, refund.created_at) < least(((series.day + 1)::timestamp at time zone 'UTC'), p_period_end)), 0)
      as revenue
    from series cross join chart_currency
  ), recent_users as (
    select profile.id, auth_user.email, profile.username,
      profile.display_name as display_name, profile.is_pro, profile.onboarded, profile.plan_id,
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
        case candidate.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 when 'link' then 2 else 3 end,
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
      'free', (select count(*) from public.profiles where coalesce(plan_id, case when is_pro then 'store' else 'free' end) = 'free'),
      'store', (select count(*) from public.profiles where coalesce(plan_id, case when is_pro then 'store' else 'free' end) in ('store', 'link', 'pro')),
      'creator', (select count(*) from public.profiles where plan_id in ('creator', 'max')),
      'creator_plus', (select count(*) from public.profiles where plan_id = 'creator_plus'),
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
      'isPro', is_pro, 'planId', plan_id, 'onboarded', onboarded, 'createdAt', created_at,
      'lastSignInAt', last_sign_in_at, 'subscriptionStatus', subscription_status,
      'amount', amount, 'currency', currency) order by created_at desc) from recent_users),
      '[]'::jsonb)
  );
$$;

revoke all on function public.get_founder_dashboard_database(timestamptz,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.get_founder_dashboard_database(timestamptz,timestamptz,integer) to service_role;

-- Exact health totals; the UI separately returns only ten recent failures.
create or replace function public.get_founder_operational_counts()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'automations', (select jsonb_build_object('total', count(*), 'enabled', count(*) filter (where enabled)) from public.instagram_dm_automations),
    'runs24h', (select jsonb_build_object('total', count(*),
      'completed', count(*) filter (where status = 'completed'),
      'awaiting', count(*) filter (where status in ('awaiting_confirmation', 'awaiting_email', 'delivering')),
      'failed', count(*) filter (where status = 'failed'))
      from public.instagram_dm_runs where created_at >= now() - interval '1 day')
  );
$$;
revoke all on function public.get_founder_operational_counts() from public, anon, authenticated;
grant execute on function public.get_founder_operational_counts() to service_role;

-- UTC daily visit counters use the same half-open range as other reports.
create or replace function public.get_founder_content_adoption(p_period_start timestamptz, p_period_end timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'brainVisitors', (select count(distinct user_id) from public.founder_brain_daily_usage),
    'brainVisitorsPeriod', (select count(distinct user_id) from public.founder_brain_daily_usage where day >= (p_period_start at time zone 'UTC')::date and day <= ((p_period_end - interval '1 microsecond') at time zone 'UTC')::date),
    'brainUsers', (select count(distinct user_id) from public.creator_brain_items where status = 'confirmed'),
    'brainUsersPeriod', (select count(distinct user_id) from public.creator_brain_items where status = 'confirmed' and updated_at >= p_period_start and updated_at < p_period_end),
    'confirmedBrainItems', (select count(*) from public.creator_brain_items where status = 'confirmed'),
    'agentUsersPeriod', (select count(distinct user_id) from public.content_agent_messages where role = 'user' and created_at >= p_period_start and created_at < p_period_end),
    'agentTurnsPeriod', (select count(*) from public.content_agent_messages where role = 'user' and created_at >= p_period_start and created_at < p_period_end),
    'routineUsersPeriod', (select count(distinct user_id) from public.content_routine_runs where created_at >= p_period_start and created_at < p_period_end),
    'routineRunsPeriod', (select count(*) from public.content_routine_runs where created_at >= p_period_start and created_at < p_period_end),
    'successfulRoutineRunsPeriod', (select count(*) from public.content_routine_runs where status = 'succeeded' and created_at >= p_period_start and created_at < p_period_end)
  );
$$;
revoke all on function public.get_founder_content_adoption(timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.get_founder_content_adoption(timestamptz,timestamptz) to service_role;
notify pgrst, 'reload schema';
