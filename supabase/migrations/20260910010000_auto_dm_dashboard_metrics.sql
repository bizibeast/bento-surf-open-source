-- Aggregate lifetime metrics independently of the 50-row activity preview.
create or replace function public.auto_dm_dashboard_metrics(p_user_id uuid, p_provider text)
returns table(provider text, automation_id uuid, matched bigint, sent bigint, failed bigint,
  runs bigint, completed bigint, confirmations bigint, emails bigint, follows bigint)
language sql stable security invoker set search_path = '' as $$
select 'instagram'::text as provider, a.id as automation_id,
    e.matched, e.sent, e.failed,
    r.runs, r.completed, r.confirmations, r.emails, r.follows
  from public.instagram_dm_automations a
  left join lateral (
    select count(*) filter (where status <> 'ignored') as matched,
      count(*) filter (where status = 'sent') as sent,
      count(*) filter (where status = 'failed') as failed
    from public.instagram_dm_events e where e.automation_id = a.id
  ) e on true
  left join lateral (
    select count(*) as runs,
      count(*) filter (where status = 'completed') as completed,
      count(*) filter (where confirmation_event_id is not null) as confirmations,
      count(*) filter (where captured_email is not null) as emails,
      count(*) filter (where follow_verified_at is not null) as follows
    from public.instagram_dm_runs r where r.automation_id = a.id and r.user_id = p_user_id
  ) r on true
  where a.user_id = p_user_id and p_provider = 'instagram'
union all
select 'facebook'::text as provider, a.id as automation_id,
    e.matched, e.sent, e.failed,
    r.runs, r.completed, r.confirmations, r.emails, r.follows
  from public.facebook_dm_automations a
  left join lateral (
    select count(*) filter (where status <> 'ignored') as matched,
      count(*) filter (where status = 'sent') as sent,
      count(*) filter (where status = 'failed') as failed
    from public.facebook_dm_events e where e.automation_id = a.id
  ) e on true
  left join lateral (
    select count(*) as runs,
      count(*) filter (where status = 'completed') as completed,
      count(*) filter (where confirmation_event_id is not null) as confirmations,
      count(*) filter (where captured_email is not null) as emails,
      null::bigint as follows
    from public.facebook_dm_runs r where r.automation_id = a.id and r.user_id = p_user_id
  ) r on true
  where a.user_id = p_user_id and p_provider = 'facebook'
union all
select 'twitter'::text as provider, a.id as automation_id,
    e.matched, e.sent, e.failed,
    null::bigint, null::bigint, null::bigint, null::bigint, null::bigint
  from public.twitter_dm_automations a
  left join lateral (
    select count(*) filter (where status <> 'ignored') as matched,
      count(*) filter (where status = 'sent') as sent,
      count(*) filter (where status = 'failed') as failed
    from public.twitter_dm_events e where e.automation_id = a.id
  ) e on true

  where a.user_id = p_user_id and p_provider = 'twitter' ;
$$;
revoke all on function public.auto_dm_dashboard_metrics(uuid, text) from public, anon, authenticated;
grant execute on function public.auto_dm_dashboard_metrics(uuid, text) to service_role;
