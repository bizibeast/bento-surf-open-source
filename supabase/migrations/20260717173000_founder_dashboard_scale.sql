-- Keep founder analytics bounded at 10k+ creators. The Worker receives compact
-- aggregates and at most 100 recent users instead of loading every block,
-- payment, refund, subscription, and auth user into memory.

create index if not exists profiles_created_at_idx
  on public.profiles(created_at desc);
create index if not exists profiles_updated_at_idx
  on public.profiles(updated_at desc, id);
create index if not exists blocks_updated_user_idx
  on public.blocks(updated_at desc, user_id);
create index if not exists pages_updated_user_idx
  on public.pages(updated_at desc, user_id);
create index if not exists payments_success_currency_time_idx
  on public.payments(currency, coalesce(occurred_at, created_at))
  where status = 'succeeded';
create index if not exists refunds_success_currency_time_idx
  on public.refunds(currency, coalesce(occurred_at, created_at))
  where status = 'succeeded';

create or replace function public.get_founder_dashboard_database(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_days integer
)
returns jsonb
language sql
stable
security definer
set search_path = public
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
    left join public.subscriptions subscription on subscription.user_id = profile.id
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

revoke all on function public.get_founder_dashboard_database(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_founder_dashboard_database(timestamptz, timestamptz, integer)
  to service_role;

create or replace function public.get_founder_journey_context(
  p_user_ids uuid[],
  p_currency text
)
returns table(user_id uuid, username text, email text, spent bigint)
language sql
stable
security definer
set search_path = public
as $$
  with wanted as (
    select distinct unnest(coalesce(p_user_ids, '{}'::uuid[])) as user_id
  ), payments_by_user as (
    select payment.user_id, sum(payment.total_amount)::bigint as gross
    from public.payments payment join wanted using (user_id)
    where payment.status = 'succeeded' and upper(payment.currency) = upper(p_currency)
    group by payment.user_id
  ), refunds_by_user as (
    select refund.user_id, sum(refund.amount)::bigint as refunds
    from public.refunds refund join wanted using (user_id)
    where refund.status = 'succeeded' and upper(refund.currency) = upper(p_currency)
    group by refund.user_id
  )
  select wanted.user_id, profile.username, auth_user.email,
    (coalesce(payments_by_user.gross, 0) - coalesce(refunds_by_user.refunds, 0))::bigint as spent
  from wanted
  left join public.profiles profile on profile.id = wanted.user_id
  left join auth.users auth_user on auth_user.id = wanted.user_id
  left join payments_by_user using (user_id)
  left join refunds_by_user using (user_id);
$$;

revoke all on function public.get_founder_journey_context(uuid[], text)
  from public, anon, authenticated;
grant execute on function public.get_founder_journey_context(uuid[], text) to service_role;

notify pgrst, 'reload schema';
