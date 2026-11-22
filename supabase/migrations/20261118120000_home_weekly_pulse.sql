-- Additive weekly summary. Existing previews and Auto DM contracts are unchanged.
create index if not exists instagram_dm_runs_home_follow_idx
  on public.instagram_dm_runs(user_id, follow_verified_at)
  where follow_verified_at is not null and follow_recheck_count > 0
    and follow_prompt_response_id is not null;
create index if not exists audience_contacts_home_lead_idx
  on public.audience_contacts(creator_id, first_seen_at)
  where first_source in ('instagram_auto_dm', 'facebook_auto_dm', 'email_capture_block', 'lead_form');
create index if not exists commerce_orders_home_revenue_idx
  on public.commerce_orders(creator_id, (coalesce(paid_at, created_at)))
  where status in ('paid', 'partially_refunded', 'refunded');

create or replace function public.get_home_weekly_pulse(
  p_user_id uuid, p_now timestamptz default now()
) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with follows as (
    -- An existing follower verified on the first check is not a gained follower.
    select count(distinct (connection_id, sender_id_hash))
        filter (where follow_verified_at >= p_now - interval '7 days') as current,
      count(distinct (connection_id, sender_id_hash))
        filter (where follow_verified_at < p_now - interval '7 days') as previous
    from public.instagram_dm_runs
    where user_id = p_user_id and follow_verified_at >= p_now - interval '14 days'
      and follow_verified_at < p_now and follow_recheck_count > 0
      and follow_prompt_response_id is not null
  ), leads as (
    -- Audience uniqueness prevents duplicate leads across runs and platforms.
    select count(*) filter (where first_seen_at >= p_now - interval '7 days') as current,
      count(*) filter (where first_seen_at < p_now - interval '7 days') as previous
    from public.audience_contacts
    where creator_id = p_user_id and first_seen_at >= p_now - interval '14 days'
      and first_seen_at < p_now
      and first_source in ('instagram_auto_dm', 'facebook_auto_dm', 'email_capture_block', 'lead_form')
  ), revenue as (
    select currency,
      coalesce(sum(greatest(gross_amount::bigint - refunded_amount, 0))
        filter (where coalesce(paid_at, created_at) >= p_now - interval '7 days'), 0) as current,
      coalesce(sum(greatest(gross_amount::bigint - refunded_amount, 0))
        filter (where coalesce(paid_at, created_at) < p_now - interval '7 days'), 0) as previous
    from public.commerce_orders
    where creator_id = p_user_id and coalesce(paid_at, created_at) >= p_now - interval '14 days'
      and coalesce(paid_at, created_at) < p_now
      and status in ('paid', 'partially_refunded', 'refunded')
    group by currency
  )
  select jsonb_build_object(
    'startedAt', p_now - interval '7 days', 'endedAt', p_now,
    'followers', jsonb_build_object('current', follows.current, 'previous', follows.previous),
    'leads', jsonb_build_object('current', leads.current, 'previous', leads.previous),
    'revenue', coalesce((select jsonb_agg(jsonb_build_object(
      'currency', currency, 'current', current, 'previous', previous
    ) order by currency) from revenue), '[]'::jsonb)
  ) from follows cross join leads;
$$;
revoke all on function public.get_home_weekly_pulse(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_home_weekly_pulse(uuid, timestamptz) to service_role;

-- Rollback: redeploy the previous Worker, then drop only this function and its
-- three home_* indexes. Never delete source orders, audience contacts or DM runs.
