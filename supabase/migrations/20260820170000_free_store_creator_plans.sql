-- Replace Link/Store with Free/Store/Creator while preserving existing rows.
alter table public.profiles drop constraint if exists profiles_plan_id_check;
alter table public.subscriptions drop constraint if exists subscriptions_plan_id_check;
alter table public.subscriptions drop constraint if exists subscriptions_pending_plan_id_check;
alter table public.complimentary_plan_grants
  drop constraint if exists complimentary_plan_grants_plan_id_check;

update public.profiles
set plan_id = case
  when plan_id = 'max' then 'creator'
  when plan_id in ('pro', 'link') then 'store'
  when plan_id in ('store', 'creator') then plan_id
  else 'free'
end;

update public.subscriptions
set plan_id = case
  when plan_id = 'max' then 'creator'
  when plan_id in ('pro', 'link') then 'store'
  when plan_id in ('store', 'creator') then plan_id
  else 'free'
end,
pending_plan_id = case
  when pending_plan_id in ('pro', 'link', 'store') then 'store'
  when pending_plan_id in ('max', 'creator') then 'creator'
  else null
end;

update public.complimentary_plan_grants
set plan_id = case when plan_id in ('max', 'creator') then 'creator' else 'store' end;

alter table public.profiles
  add constraint profiles_plan_id_check check (plan_id in ('free', 'store', 'creator'));
alter table public.subscriptions
  add constraint subscriptions_plan_id_check check (plan_id in ('free', 'store', 'creator')),
  add constraint subscriptions_pending_plan_id_check
    check (pending_plan_id is null or pending_plan_id in ('store', 'creator'));
alter table public.complimentary_plan_grants
  add constraint complimentary_plan_grants_plan_id_check check (plan_id in ('store', 'creator'));

update public.profiles set is_pro = (plan_id <> 'free');

create or replace function public.enforce_free_page_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
     and (select count(*) from public.pages where user_id = new.user_id) >= 4 then
    raise exception 'Free includes up to 5 pages.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_free_page_limit on public.pages;
create trigger enforce_free_page_limit
before insert on public.pages
for each row execute function public.enforce_free_page_limit();

create or replace function public.enforce_instagram_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
     and (
       coalesce(array_length(new.excluded_keywords, 1), 0) > 0
       or new.public_reply_enabled
       or new.opening_message is not null
       or new.confirmation_button_label is not null
       or new.email_capture_enabled
       or new.email_marketing_consent_enabled
       or new.follow_gate_enabled
     ) then
    raise exception 'Advanced Auto DMs require the Store plan.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_instagram_auto_dm_plan on public.instagram_dm_automations;
create trigger enforce_instagram_auto_dm_plan
before insert or update on public.instagram_dm_automations
for each row execute function public.enforce_instagram_auto_dm_plan();

create or replace function public.enforce_facebook_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
     and (
       coalesce(array_length(new.excluded_keywords, 1), 0) > 0
       or new.public_reply_enabled
       or new.opening_message is not null
       or new.confirmation_button_label is not null
       or new.email_capture_enabled
       or new.email_marketing_consent_enabled
     ) then
    raise exception 'Advanced Auto DMs require the Store plan.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_facebook_auto_dm_plan on public.facebook_dm_automations;
create trigger enforce_facebook_auto_dm_plan
before insert or update on public.facebook_dm_automations
for each row execute function public.enforce_facebook_auto_dm_plan();

create or replace function public.enforce_twitter_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
     and coalesce(array_length(new.excluded_keywords, 1), 0) > 0 then
    raise exception 'Advanced Auto DMs require the Store plan.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_twitter_auto_dm_plan on public.twitter_dm_automations;
create trigger enforce_twitter_auto_dm_plan
before insert or update on public.twitter_dm_automations
for each row execute function public.enforce_twitter_auto_dm_plan();

create or replace function public.disable_advanced_auto_dms_on_free()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.plan_id = 'free' and old.plan_id <> 'free' then
    update public.instagram_dm_automations
    set enabled = false, updated_at = now()
    where user_id = new.id and (
      coalesce(array_length(excluded_keywords, 1), 0) > 0
      or public_reply_enabled
      or opening_message is not null
      or confirmation_button_label is not null
      or email_capture_enabled
      or email_marketing_consent_enabled
      or follow_gate_enabled
    );

    update public.facebook_dm_automations
    set enabled = false, updated_at = now()
    where user_id = new.id and (
      coalesce(array_length(excluded_keywords, 1), 0) > 0
      or public_reply_enabled
      or opening_message is not null
      or confirmation_button_label is not null
      or email_capture_enabled
      or email_marketing_consent_enabled
    );

    update public.twitter_dm_automations
    set enabled = false, updated_at = now()
    where user_id = new.id and coalesce(array_length(excluded_keywords, 1), 0) > 0;
  end if;
  return new;
end;
$$;

drop trigger if exists disable_advanced_auto_dms_on_free on public.profiles;
create trigger disable_advanced_auto_dms_on_free
after update of plan_id on public.profiles
for each row execute function public.disable_advanced_auto_dms_on_free();

create or replace function public.grant_complimentary_plan(
  p_email text,
  p_plan_id text,
  p_granted_by uuid,
  p_duration_days integer default 365
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
  v_effective_plan text;
begin
  if p_plan_id not in ('store', 'creator') then
    raise exception 'Complimentary access must use the Store or Creator plan.';
  end if;
  if p_duration_days is null or p_duration_days < 1 or p_duration_days > 3650 then
    raise exception 'Complimentary access duration must be between 1 and 3650 days.';
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_email))
  limit 1;
  if v_user_id is null then
    raise exception 'No Bento account was found for that email.';
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by case subscription.plan_id when 'creator' then 0 when 'store' then 1 else 2 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator') then
    v_paid_plan := 'free';
  end if;

  v_effective_plan := case
    when p_plan_id = 'creator' or v_paid_plan = 'creator' then 'creator'
    else 'store'
  end;

  insert into public.complimentary_plan_grants (
    user_id, plan_id, status, granted_by, granted_at, expires_at, updated_at, revoked_at
  ) values (
    v_user_id, p_plan_id, 'active', p_granted_by, now(),
    now() + make_interval(days => p_duration_days), now(), null
  )
  on conflict (user_id) do update set
    plan_id = excluded.plan_id,
    status = 'active',
    granted_by = excluded.granted_by,
    granted_at = excluded.granted_at,
    expires_at = excluded.expires_at,
    updated_at = now(),
    revoked_at = null;

  update public.profiles
  set plan_id = v_effective_plan, is_pro = true, updated_at = now()
  where id = v_user_id;
end;
$$;

create or replace function public.revoke_complimentary_plan(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
begin
  update public.complimentary_plan_grants
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where id = p_grant_id and status = 'active'
  returning user_id into v_user_id;
  if v_user_id is null then
    raise exception 'That complimentary plan is no longer active.';
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by case subscription.plan_id when 'creator' then 0 when 'store' then 1 else 2 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'), updated_at = now()
  where id = v_user_id;
end;
$$;

create or replace function public.expire_complimentary_plan_grant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
begin
  update public.complimentary_plan_grants
  set status = 'expired', updated_at = now()
  where id = p_grant_id and status = 'active' and expires_at <= now()
  returning user_id into v_user_id;
  if v_user_id is null then return; end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by case subscription.plan_id when 'creator' then 0 when 'store' then 1 else 2 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'), updated_at = now()
  where id = v_user_id;
end;
$$;

revoke all on function public.enforce_free_page_limit() from public, anon, authenticated;
revoke all on function public.enforce_instagram_auto_dm_plan() from public, anon, authenticated;
revoke all on function public.enforce_facebook_auto_dm_plan() from public, anon, authenticated;
revoke all on function public.enforce_twitter_auto_dm_plan() from public, anon, authenticated;
revoke all on function public.disable_advanced_auto_dms_on_free() from public, anon, authenticated;
revoke all on function public.grant_complimentary_plan(text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.revoke_complimentary_plan(uuid) from public, anon, authenticated;
revoke all on function public.expire_complimentary_plan_grant(uuid)
  from public, anon, authenticated;

grant execute on function public.grant_complimentary_plan(text, text, uuid, integer) to service_role;
grant execute on function public.revoke_complimentary_plan(uuid) to service_role;
grant execute on function public.expire_complimentary_plan_grant(uuid) to service_role;

notify pgrst, 'reload schema';
