-- Weekly digest moves to the worker so one person gets one email per ISO week.
-- Onboarding lifecycle rows stay on this function, unchanged.
-- Marketing and transactional daily caps match Resend's free plan (100/day,
-- shared with Auth SMTP): marketing 70, transactional 100. The worker may
-- lower these further from EMAIL_MARKETING_DAILY_CAP and
-- EMAIL_TRANSACTIONAL_DAILY_CAP. Service role can still update the rows.

create or replace function public.enqueue_due_lifecycle_emails()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  insert into public.email_outbox(
    event_key, event_type, category, recipient_email, recipient_name, user_id, payload
  )
  select
    lifecycle.event_key,
    lifecycle.event_type,
    'marketing',
    lower(auth_user.email),
    nullif(profile.display_name, ''),
    profile.id,
    jsonb_build_object('username', profile.username)
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  join public.email_preferences preference on preference.user_id = profile.id
  cross join lateral (
    values
      ('onboarding-quick-win:' || profile.id::text, 'onboarding_quick_win', interval '1 day'),
      ('commerce-feature:' || profile.id::text, 'commerce_feature', interval '3 days'),
      ('pro-upgrade:' || profile.id::text, 'pro_upgrade', interval '10 days')
  ) as lifecycle(event_key, event_type, delay)
  where preference.product_updates
    and preference.marketing_unsubscribed_at is null
    and auth_user.email is not null
    and length(auth_user.email) between 3 and 254
    and auth_user.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and auth_user.email_confirmed_at is not null
    and auth_user.email_confirmed_at <= now() - lifecycle.delay
    and (lifecycle.event_type <> 'pro_upgrade' or not profile.is_pro)
  on conflict (event_key) do nothing;
  get diagnostics inserted_count = row_count;

  return inserted_count;
end;
$$;

revoke all on function public.enqueue_due_lifecycle_emails() from public, anon, authenticated;
grant execute on function public.enqueue_due_lifecycle_emails() to service_role;

-- ponytail: one grouped scan of the last 7 days. Replace with a pre-aggregated
-- weekly table if opted-in workspaces grow past a few thousand.
create or replace function public.weekly_digest_page_stats(p_since date)
returns table (
  auth_user_id uuid,
  email text,
  recipient_name text,
  workspace_id uuid,
  username text,
  views bigint,
  clicks bigint,
  sales bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select
      auth_user.id as auth_user_id,
      lower(auth_user.email) as email,
      nullif(owner_profile.display_name, '') as recipient_name
    from public.email_preferences preference
    join auth.users auth_user on auth_user.id = preference.user_id
    left join public.profiles owner_profile on owner_profile.id = auth_user.id
    where preference.weekly_digest
      and preference.marketing_unsubscribed_at is null
      and auth_user.email is not null
      and length(auth_user.email) between 3 and 254
      and auth_user.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
      and auth_user.email_confirmed_at is not null
  ),
  workspaces as (
    select
      eligible.auth_user_id,
      eligible.email,
      eligible.recipient_name,
      profile.id as workspace_id,
      profile.username
    from eligible
    join public.profiles profile
      on profile.id = eligible.auth_user_id
     and profile.workspace_status = 'active'
    union
    select
      eligible.auth_user_id,
      eligible.email,
      eligible.recipient_name,
      profile.id,
      profile.username
    from eligible
    join public.workspace_memberships membership
      on membership.auth_user_id = eligible.auth_user_id
     and membership.role = 'owner'
     and membership.status = 'active'
    join public.profiles profile
      on profile.id = membership.workspace_id
     and profile.workspace_status = 'active'
  )
  select
    workspaces.auth_user_id,
    workspaces.email,
    workspaces.recipient_name,
    workspaces.workspace_id,
    workspaces.username,
    coalesce(visits.views, 0)::bigint,
    coalesce(visits.clicks, 0)::bigint,
    coalesce(orders.sales, 0)::bigint
  from workspaces
  left join (
    select day.user_id, sum(day.views) as views, sum(day.clicks) as clicks
    from public.analytics_daily day
    where day.day >= p_since
    group by day.user_id
  ) visits on visits.user_id = workspaces.workspace_id
  left join (
    select commerce.creator_id, count(*) as sales
    from public.commerce_orders commerce
    where commerce.status = 'paid'
      and commerce.paid_at >= (p_since::timestamp at time zone 'UTC')
    group by commerce.creator_id
  ) orders on orders.creator_id = workspaces.workspace_id;
$$;

revoke all on function public.weekly_digest_page_stats(date) from public, anon, authenticated;
grant execute on function public.weekly_digest_page_stats(date) to service_role;

update public.provider_budget_policies
set daily_limit = 70
where resource = 'marketing_emails';

update public.provider_budget_policies
set daily_limit = 100
where resource = 'transactional_emails';

notify pgrst, 'reload schema';
