-- Forward repair: profiles represent workspaces, not authentication accounts.
-- Keep account milestones distinct across owned workspaces, and count workspace
-- plan mix separately. The previously applied reporting migration stays intact.
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
  with account_milestones as (
    select account.id,
      exists (select 1 from public.workspace_memberships membership
        join public.profiles workspace on workspace.id=membership.workspace_id
        where membership.auth_user_id=account.id and membership.role='owner'
          and membership.status='active' and workspace.onboarded) as onboarded,
      exists (select 1 from public.workspace_memberships membership
        join public.blocks block on block.user_id=membership.workspace_id
        where membership.auth_user_id=account.id and membership.role='owner'
          and membership.status='active') as has_block,
      exists (select 1 from public.workspace_memberships membership
        join public.profiles workspace on workspace.id=membership.workspace_id
        where membership.auth_user_id=account.id and membership.role='owner'
          and membership.status='active'
          and coalesce(workspace.plan_id, case when workspace.is_pro then 'store' else 'free' end)
            in ('store','link','pro','creator','max','creator_plus')) as upgraded
    from auth.users account
  ), payment_totals as (
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
      (select count(*) from auth.users account
       where account.created_at >= greatest((series.day::timestamp at time zone 'UTC'), p_period_start)
         and account.created_at < least(((series.day + 1)::timestamp at time zone 'UTC'), p_period_end))::bigint as signups
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
    select auth_user.id, auth_user.email,
      coalesce(profile.username, 'no-workspace') as username,
      profile.display_name, milestone.upgraded as is_pro, milestone.onboarded,
      profile.plan_id, auth_user.created_at, auth_user.last_sign_in_at,
      subscription.status::text as subscription_status,
      subscription.amount, subscription.currency
    from auth.users auth_user
    join account_milestones milestone on milestone.id=auth_user.id
    -- Show the account's original workspace, or its oldest remaining owned
    -- workspace. Additional workspaces must not create additional account rows.
    left join lateral (
      select workspace.* from public.workspace_memberships membership
      join public.profiles workspace on workspace.id=membership.workspace_id
      where membership.auth_user_id=auth_user.id and membership.role='owner'
        and membership.status='active'
      order by (workspace.id=auth_user.id) desc, workspace.created_at asc, workspace.id
      limit 1
    ) profile on true
    left join lateral (
      select candidate.status, candidate.amount, candidate.currency
      from public.subscriptions candidate
      where candidate.user_id=profile.id
      order by case when candidate.status in ('active','trialing','past_due') then 0 else 1 end,
        case candidate.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 when 'link' then 2 else 3 end,
        case candidate.status when 'active' then 0 when 'trialing' then 1 else 2 end,
        candidate.updated_at desc nulls last, candidate.created_at desc nulls last, candidate.id
      limit 1
    ) subscription on true
    order by auth_user.created_at desc, auth_user.id
    limit 100
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'users', (select count(*) from auth.users),
      'workspaces', (select count(*) from public.profiles),
      'onboarded', (select count(*) from account_milestones where onboarded),
      'pro', (select count(*) from account_milestones where upgraded),
      'free', (select count(*) from public.profiles where coalesce(plan_id, case when is_pro then 'store' else 'free' end) = 'free'),
      'store', (select count(*) from public.profiles where coalesce(plan_id, case when is_pro then 'store' else 'free' end) in ('store', 'link', 'pro')),
      'creator', (select count(*) from public.profiles where plan_id in ('creator', 'max')),
      'creator_plus', (select count(*) from public.profiles where plan_id = 'creator_plus'),
      'newUsers7d', (select count(*) from auth.users where created_at >= now() - interval '7 days'),
      'newUsersPeriod', (select count(*) from auth.users
        where created_at >= p_period_start and created_at < p_period_end)
    ),
    'funnel', jsonb_build_array(
      jsonb_build_object('label', 'Accounts created', 'value', (select count(*) from auth.users)),
      jsonb_build_object('label', 'Accounts with a block', 'value',
        (select count(*) from account_milestones where has_block)),
      jsonb_build_object('label', 'Onboarded accounts', 'value',
        (select count(*) from account_milestones where onboarded)),
      jsonb_build_object('label', 'Accounts with an upgraded workspace', 'value',
        (select count(*) from account_milestones where upgraded))
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


notify pgrst, 'reload schema';
