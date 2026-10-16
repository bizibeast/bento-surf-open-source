-- Founder-only retention reporting. Billing events are the historical source;
-- cancellation-intent metrics start when the new flow launches. No raw feedback
-- text or customer identifiers leave this aggregate function.
create function public.get_founder_retention_metrics(
  p_period_start timestamptz,
  p_period_end timestamptz
) returns jsonb language sql stable security definer set search_path = '' as $$
with first_intents as (
  select offer_accepted_at, reason
  from public.cancellation_intents
  where first_attempt and created_at >= p_period_start and created_at < p_period_end
), intent_counts as (
  select count(*)::integer as attempts,
    count(*) filter (where offer_accepted_at is not null)::integer as saved
  from first_intents
), previously_paid as (
  select distinct user_id from public.payments
  where user_id is not null and subscription_id is not null
    and status='succeeded' and total_amount>0
    and coalesce(occurred_at,created_at)<p_period_start
), latest_preperiod_state as (
  select distinct on (user_id) user_id,event_type
  from public.billing_events
  where user_id is not null and status='processed'
    and event_type like 'subscription.%'
    and coalesce(occurred_at,created_at)<p_period_start
  order by user_id,coalesce(occurred_at,created_at) desc,created_at desc
), starting_paid as (
  select state.user_id from latest_preperiod_state state
  join previously_paid paid using(user_id)
  where state.event_type not in
    ('subscription.cancelled','subscription.expired','subscription.failed',
     'subscription.on_hold','subscription.paused')
), period_losses as (
  select distinct event.user_id,
    case when event.event_type in ('subscription.cancelled','subscription.expired')
      then 'voluntary' else 'involuntary' end as kind
  from public.billing_events event join starting_paid starting using(user_id)
  where event.status='processed' and event.event_type in
    ('subscription.cancelled','subscription.expired','subscription.failed','subscription.on_hold')
    and coalesce(event.occurred_at,event.created_at)>=p_period_start
    and coalesce(event.occurred_at,event.created_at)<p_period_end
), churn_counts as (
  select (select count(*) from starting_paid)::integer as starting_paid,
    count(distinct user_id) filter (where kind='voluntary')::integer as voluntary,
    count(distinct user_id) filter (where kind='involuntary')::integer as involuntary
  from period_losses
), matured_losses as (
  select distinct on (event.user_id) event.user_id,
    coalesce(event.occurred_at,event.created_at) as lost_at
  from public.billing_events event
  where event.user_id is not null and event.status='processed'
    and event.event_type in ('subscription.cancelled','subscription.expired')
    and coalesce(event.occurred_at,event.created_at)>=p_period_start-interval '30 days'
    and coalesce(event.occurred_at,event.created_at)<p_period_end-interval '30 days'
    and exists(select 1 from public.payments prior
      where prior.user_id=event.user_id and prior.subscription_id is not null
        and prior.status='succeeded' and prior.total_amount>0
        and coalesce(prior.occurred_at,prior.created_at)<coalesce(event.occurred_at,event.created_at))
  order by event.user_id,coalesce(event.occurred_at,event.created_at)
), reactivation_counts as (
  select count(*)::integer as eligible,
    count(*) filter (where exists(
      select 1 from public.payments payment
      where payment.user_id=loss.user_id and payment.subscription_id is not null
        and payment.status='succeeded' and payment.total_amount>0
        and coalesce(payment.occurred_at,payment.created_at)>loss.lost_at
        and coalesce(payment.occurred_at,payment.created_at)<=loss.lost_at+interval '30 days'
    ))::integer as returned
  from matured_losses loss
), net_by_customer as (
  select payment.user_id,upper(payment.currency) as currency,
    sum(payment.total_amount-coalesce(refund.amount,0))::bigint as net_minor
  from public.payments payment
  left join (
    select payment_id,sum(amount)::bigint as amount from public.refunds
    where status='succeeded' group by payment_id
  ) refund using(payment_id)
  where payment.user_id is not null and payment.subscription_id is not null
    and payment.status='succeeded' and payment.total_amount>0
  group by payment.user_id,upper(payment.currency)
), ltv as (
  select currency,count(*)::integer as paying_customers,
    round(avg(net_minor))::bigint as realized_ltv_minor
  from net_by_customer group by currency
), reasons as (
  select reason,count(*)::integer as attempts from first_intents
  where reason is not null group by reason
)
select jsonb_build_object(
  'save', (select jsonb_build_object('attempts',attempts,'saved',saved,
    'rate',case when attempts>0 then round(saved::numeric/attempts,4) else null end)
    from intent_counts),
  'churn', (select jsonb_build_object('startingPaid',starting_paid,
    'voluntary',voluntary,'involuntary',involuntary,
    'rate',case when starting_paid>0 then round(voluntary::numeric/starting_paid,4) else null end)
    from churn_counts),
  'reactivation', (select jsonb_build_object('eligible',eligible,'returned',returned,
    'rate',case when eligible>0 then round(returned::numeric/eligible,4) else null end)
    from reactivation_counts),
  'ltv',coalesce((select jsonb_agg(jsonb_build_object('currency',currency,
    'payingCustomers',paying_customers,'realizedLtvMinor',realized_ltv_minor)
    order by currency) from ltv),'[]'::jsonb),
  'pausesNeedingReview',(select count(*) from public.subscription_pauses
    where resumed_at is null and resume_attempts>=8),
  'reasons',coalesce((select jsonb_agg(jsonb_build_object('reason',reason,'attempts',attempts)
    order by attempts desc,reason) from reasons),'[]'::jsonb)
);
$$;
revoke all on function public.get_founder_retention_metrics(timestamptz,timestamptz)
  from public,anon,authenticated;
grant execute on function public.get_founder_retention_metrics(timestamptz,timestamptz)
  to service_role;
notify pgrst,'reload schema';
