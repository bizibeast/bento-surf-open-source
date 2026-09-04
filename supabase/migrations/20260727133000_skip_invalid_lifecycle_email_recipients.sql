-- Auth providers may retain legacy or placeholder values in auth.users.email.
-- Lifecycle email generation must skip those rows instead of aborting the
-- entire daily batch on the email_outbox recipient constraint.

create or replace function public.enqueue_due_lifecycle_emails()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
  weekly_count integer := 0;
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

  if extract(isodow from now() at time zone 'UTC') = 1 then
    insert into public.email_outbox(
      event_key, event_type, category, recipient_email, recipient_name, user_id, payload
    )
    select
      'weekly-digest:' || profile.id::text || ':' || date_trunc('week', now() at time zone 'UTC')::date,
      'weekly_digest',
      'marketing',
      lower(auth_user.email),
      nullif(profile.display_name, ''),
      profile.id,
      jsonb_build_object(
        'username', profile.username,
        'views', coalesce((select sum(day.views) from public.analytics_daily day
          where day.user_id = profile.id and day.day >= current_date - 7), 0),
        'clicks', coalesce((select sum(day.clicks) from public.analytics_daily day
          where day.user_id = profile.id and day.day >= current_date - 7), 0),
        'sales', coalesce((select count(*) from public.commerce_orders orders
          where orders.creator_id = profile.id and orders.status = 'paid'
            and orders.paid_at >= now() - interval '7 days'), 0)
      )
    from public.profiles profile
    join auth.users auth_user on auth_user.id = profile.id
    join public.email_preferences preference on preference.user_id = profile.id
    where preference.weekly_digest
      and preference.marketing_unsubscribed_at is null
      and auth_user.email is not null
      and length(auth_user.email) between 3 and 254
      and auth_user.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
      and auth_user.email_confirmed_at is not null
    on conflict (event_key) do nothing;
    get diagnostics weekly_count = row_count;
  end if;

  return inserted_count + weekly_count;
end;
$$;

revoke all on function public.enqueue_due_lifecycle_emails() from public, anon, authenticated;
grant execute on function public.enqueue_due_lifecycle_emails() to service_role;

notify pgrst, 'reload schema';
