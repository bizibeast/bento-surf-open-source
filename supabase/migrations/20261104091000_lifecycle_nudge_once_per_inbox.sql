-- One onboarding nudge step per inbox.
-- The outbox stores the account email (plus-tags stay). Gmail and Googlemail
-- share a step because dots and plus-tags are the same inbox. Test and
-- disposable addresses are not queued. Sandbox suppresses all nudges before
-- reserving budget or creating unsubscribe tokens.

create or replace function public.lifecycle_nudge_inbox_key(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when domain in ('gmail.com', 'googlemail.com') then
      replace(split_part(local_part, '+', 1), '.', '') || '@gmail.com'
    else email
  end
  from (
    select
      lower(btrim(p_email)) as email,
      split_part(lower(btrim(p_email)), '@', 1) as local_part,
      split_part(lower(btrim(p_email)), '@', 2) as domain
  ) parsed
  where p_email is not null
    and length(email) between 3 and 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and (
      domain not in ('gmail.com', 'googlemail.com')
      or length(replace(split_part(local_part, '+', 1), '.', '')) > 0
    );
$$;

-- Preserve delivery history while removing duplicate rows from the active index.
with ranked as (
  select id, status as old_status,
    row_number() over (
      partition by event_type, public.lifecycle_nudge_inbox_key(recipient_email)
      order by case status
        when 'sent' then 0
        when 'processing' then 1
        when 'pending' then 2
        when 'failed' then 3
        else 4
      end, coalesce(sent_at, created_at), id
    ) as inbox_rank
  from public.email_outbox
  where event_type in ('onboarding_quick_win','commerce_feature','pro_upgrade')
    and public.lifecycle_nudge_inbox_key(recipient_email) is not null
    and status <> 'suppressed'
)
update public.email_outbox as outbox
set status = 'suppressed',
    last_error = 'Duplicate inbox for this nudge step (dedupe migration). Was ' || ranked.old_status,
    updated_at = now()
from ranked
where outbox.id = ranked.id and ranked.inbox_rank > 1;

-- Suppressed rows leave the index, but enqueue's not exists still blocks re-queueing.
create unique index if not exists email_outbox_lifecycle_nudge_inbox_key
on public.email_outbox (event_type, public.lifecycle_nudge_inbox_key(recipient_email))
where event_type in ('onboarding_quick_win','commerce_feature','pro_upgrade') and status <> 'suppressed';

create or replace function public.is_disposable_or_test_email(p_email text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  email text := lower(btrim(coalesce(p_email, '')));
  local_part text;
  domain text;
  plus_tag text;
  token text;
  suffix text;
begin
  if length(email) < 3
    or length(email) > 254
    or email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return false;
  end if;
  local_part := split_part(email, '@', 1);
  domain := split_part(email, '@', 2);
  if domain in ('example.com', 'example.net', 'example.org')
    or domain ~ '(^|\.)(example|invalid|localhost|test)$' then
    return true;
  end if;
  suffix := domain;
  while suffix <> '' loop
    if suffix in (
      '10minutemail.com',
      '10minutemail.net',
      'caps7.com',
      'discard.email',
      'dispostable.com',
      'getnada.com',
      'grr.la',
      'guerrillamail.biz',
      'guerrillamail.com',
      'guerrillamail.de',
      'guerrillamail.info',
      'guerrillamail.net',
      'guerrillamail.org',
      'guerrillamailblock.com',
      'maildrop.cc',
      'mail.grokbot.com',
      'mailinator.com',
      'mailinator.net',
      'mailnesia.com',
      'sharklasers.com',
      'temp-mail.org',
      'tempmail.com',
      'trashmail.com',
      'yopmail.com',
      'yopmail.fr',
      'yopmail.net'
    ) then
      return true;
    end if;
    if position('.' in suffix) = 0 then
      exit;
    end if;
    suffix := substring(suffix from position('.' in suffix) + 1);
  end loop;
  if position('+' in local_part) > 0 then
    plus_tag := substring(local_part from position('+' in local_part) + 1);
    foreach token in array regexp_split_to_array(plus_tag, '[^a-z0-9]+') loop
      if token ~ '^(test[0-9]*|qa[0-9]*|googleoauth[a-z0-9]*)$' then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

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
    due.event_key,
    due.event_type,
    'marketing',
    due.recipient_email,
    due.recipient_name,
    due.user_id,
    due.payload
  from (
    select distinct on (inbox_key, event_type)
      public.lifecycle_nudge_inbox_key(lower(auth_user.email)) as inbox_key,
      lifecycle.event_key,
      lifecycle.event_type,
      lower(auth_user.email) as recipient_email,
      nullif(profile.display_name, '') as recipient_name,
      profile.id as user_id,
      jsonb_build_object('username', profile.username) as payload
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
      and not public.is_disposable_or_test_email(auth_user.email)
      and public.lifecycle_nudge_inbox_key(lower(auth_user.email)) is not null
      and not exists (
        select 1
        from public.email_outbox existing
        where existing.event_type = lifecycle.event_type
          and public.lifecycle_nudge_inbox_key(existing.recipient_email)
            = public.lifecycle_nudge_inbox_key(lower(auth_user.email))
      )
    order by inbox_key, event_type, profile.id
  ) due
  on conflict do nothing;
  get diagnostics inserted_count = row_count;

  return inserted_count;
end;
$$;

revoke all on function public.lifecycle_nudge_inbox_key(text) from public, anon, authenticated;
grant execute on function public.lifecycle_nudge_inbox_key(text) to service_role;
revoke all on function public.is_disposable_or_test_email(text) from public, anon, authenticated;
grant execute on function public.is_disposable_or_test_email(text) to service_role;
revoke all on function public.enqueue_due_lifecycle_emails() from public, anon, authenticated;
grant execute on function public.enqueue_due_lifecycle_emails() to service_role;

notify pgrst, 'reload schema';
