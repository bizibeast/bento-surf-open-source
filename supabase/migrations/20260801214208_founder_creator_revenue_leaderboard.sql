-- Founder-only creator GMV reporting. This is intentionally separate from
-- Bento subscription revenue: it measures money creators generate through
-- their Bento storefronts, grouped by currency so unlike currencies are never
-- combined into a misleading total.

create index if not exists commerce_orders_founder_revenue_idx
  on public.commerce_orders ((coalesce(paid_at, created_at)) desc, currency, creator_id)
  where status in ('paid', 'partially_refunded', 'refunded');

create or replace function public.get_founder_creator_revenue(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with recognized_orders as (
    select
      order_row.creator_id,
      lower(order_row.buyer_email) as buyer_email,
      upper(order_row.currency) as currency,
      order_row.gross_amount,
      order_row.refunded_amount,
      order_row.net_amount,
      order_row.platform_fee_amount,
      order_row.processor_fee_amount,
      coalesce(order_row.paid_at, order_row.created_at) as sale_at
    from public.commerce_orders order_row
    where order_row.status in ('paid', 'partially_refunded', 'refunded')
      and coalesce(order_row.paid_at, order_row.created_at) >= p_period_start
      and coalesce(order_row.paid_at, order_row.created_at) < p_period_end
  ),
  creator_currency_totals as (
    select
      creator_id,
      currency,
      count(*)::bigint as orders,
      count(distinct buyer_email)::bigint as customers,
      sum(gross_amount)::bigint as gross,
      sum(refunded_amount)::bigint as refunds,
      sum(greatest(0, gross_amount - refunded_amount))::bigint as revenue,
      sum(greatest(0, net_amount - refunded_amount))::bigint as net,
      sum(platform_fee_amount + processor_fee_amount)::bigint as fees,
      max(sale_at) as latest_sale_at
    from recognized_orders
    group by creator_id, currency
  ),
  ranked_creators as (
    select
      totals.*,
      dense_rank() over (
        partition by totals.currency
        order by totals.revenue desc, totals.net desc, totals.orders desc, totals.creator_id
      )::bigint as rank
    from creator_currency_totals totals
  ),
  limited_creators as (
    select *
    from ranked_creators
    where rank <= least(greatest(coalesce(p_limit, 50), 1), 100)
  ),
  currency_totals as (
    select
      currency,
      count(distinct creator_id)::bigint as creators,
      count(*)::bigint as orders,
      sum(gross_amount)::bigint as gross,
      sum(refunded_amount)::bigint as refunds,
      sum(greatest(0, gross_amount - refunded_amount))::bigint as revenue,
      sum(greatest(0, net_amount - refunded_amount))::bigint as net,
      sum(platform_fee_amount + processor_fee_amount)::bigint as fees
    from recognized_orders
    group by currency
  ),
  overall_totals as (
    select count(distinct creator_id)::bigint as creators
    from recognized_orders
  )
  select jsonb_build_object(
    'creatorCount', (select creators from overall_totals),
    'totals', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'currency', currency,
            'creators', creators,
            'orders', orders,
            'gross', gross,
            'refunds', refunds,
            'revenue', revenue,
            'net', net,
            'fees', fees
          )
          order by revenue desc, currency
        )
        from currency_totals
      ),
      '[]'::jsonb
    ),
    'leaderboard', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'rank', ranked.rank,
            'creatorId', ranked.creator_id,
            'username', coalesce(
              profile.username,
              'creator-' || left(ranked.creator_id::text, 8)
            ),
            'displayName', profile.display_name,
            'avatarUrl', profile.avatar_url,
            'currency', ranked.currency,
            'orders', ranked.orders,
            'customers', ranked.customers,
            'gross', ranked.gross,
            'refunds', ranked.refunds,
            'revenue', ranked.revenue,
            'net', ranked.net,
            'fees', ranked.fees,
            'latestSaleAt', ranked.latest_sale_at
          )
          order by ranked.currency, ranked.rank, profile.username
        )
        from limited_creators ranked
        left join public.profiles profile on profile.id = ranked.creator_id
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.get_founder_creator_revenue(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_founder_creator_revenue(timestamptz, timestamptz, integer)
  to service_role;
