-- New sales use the October catalog. Existing rows keep their contract bundle.
alter table public.profiles add column if not exists billing_catalog text not null default 'legacy';
alter table public.profiles alter column billing_catalog set default '2026-10';
alter table public.profiles add column if not exists trial_ends_at timestamptz;
alter table public.subscriptions add column if not exists billing_catalog text not null default 'legacy';
alter table public.subscriptions alter column billing_catalog set default '2026-10';
alter table public.subscriptions add column if not exists trial_ends_at timestamptz;
alter table public.profiles add constraint profiles_billing_catalog_check check (billing_catalog in ('legacy', '2026-10'));
alter table public.subscriptions add constraint subscriptions_billing_catalog_check check (billing_catalog in ('legacy', '2026-10'));
alter table public.profiles drop constraint if exists profiles_plan_id_check;
alter table public.profiles add constraint profiles_plan_id_check check (plan_id in ('free', 'store', 'creator', 'creator_plus'));
alter table public.subscriptions drop constraint if exists subscriptions_plan_id_check;
alter table public.subscriptions add constraint subscriptions_plan_id_check check (plan_id in ('free', 'store', 'creator', 'creator_plus'));
alter table public.subscriptions drop constraint if exists subscriptions_pending_plan_id_check;
alter table public.subscriptions add constraint subscriptions_pending_plan_id_check check (pending_plan_id is null or pending_plan_id in ('store', 'creator', 'creator_plus'));
alter table public.complimentary_plan_grants drop constraint if exists complimentary_plan_grants_plan_id_check;
alter table public.complimentary_plan_grants add constraint complimentary_plan_grants_plan_id_check check (plan_id in ('store', 'creator', 'creator_plus'));

-- Billing fields and activation cannot be written through the browser's profile policy.
create or replace function public.protect_hosted_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() in ('authenticated', 'anon') then
    if new.plan_id is distinct from old.plan_id or new.is_pro is distinct from old.is_pro
       or new.billing_catalog is distinct from old.billing_catalog
       or new.trial_ends_at is distinct from old.trial_ends_at then
      raise exception 'Billing access is managed by the server.';
    end if;
    if new.billing_catalog = '2026-10' and new.onboarded and not old.onboarded then
      raise exception 'Complete verified onboarding activation first.';
    end if;
  end if;
  return new;
end; $$;
create trigger protect_hosted_access before update on public.profiles
for each row execute function public.protect_hosted_access();
revoke all on function public.protect_hosted_access() from public, anon, authenticated;

-- Only trusted deployment configuration controls the self-hosted edition.
create table public.bento_instance_settings (
  singleton boolean primary key default true check (singleton),
  edition text not null default 'hosted' check (edition in ('hosted', 'self_hosted'))
);
insert into public.bento_instance_settings (singleton, edition) values (true, 'hosted');
alter table public.bento_instance_settings enable row level security;
revoke all on public.bento_instance_settings from public, anon, authenticated;
grant all on public.bento_instance_settings to service_role;

create or replace function public.bento_has_advanced_dms(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bento_instance_settings where edition = 'self_hosted')
    or exists (select 1 from public.profiles p where p.id = p_user_id and (
      p.trial_ends_at > now() or
      (p.trial_ends_at is null and (p.plan_id in ('creator', 'creator_plus')
        or (p.plan_id = 'store' and p.billing_catalog = 'legacy')))
    ));
$$;
revoke all on function public.bento_has_advanced_dms(uuid) from public, anon, authenticated;
grant execute on function public.bento_has_advanced_dms(uuid) to service_role;

create or replace function public.enforce_instagram_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.enabled
     and not public.bento_has_advanced_dms(new.user_id)
     and (
       coalesce(array_length(new.excluded_keywords, 1), 0) > 0
       or new.public_reply_enabled
       or new.opening_message is not null
       or new.confirmation_button_label is not null
       or new.email_capture_enabled
       or new.email_marketing_consent_enabled
       or new.follow_gate_enabled
     ) then
    raise exception 'Advanced Auto DMs require the Creator plan.';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_facebook_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.enabled
     and not public.bento_has_advanced_dms(new.user_id)
     and (
       coalesce(array_length(new.excluded_keywords, 1), 0) > 0
       or new.public_reply_enabled
       or new.opening_message is not null
       or new.confirmation_button_label is not null
       or new.email_capture_enabled
       or new.email_marketing_consent_enabled
     ) then
    raise exception 'Advanced Auto DMs require the Creator plan.';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_twitter_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.enabled
     and not public.bento_has_advanced_dms(new.user_id)
     and coalesce(array_length(new.excluded_keywords, 1), 0) > 0 then
    raise exception 'Advanced Auto DMs require the Creator plan.';
  end if;
  return new;
end;
$$;

create or replace function public.pause_unentitled_auto_dms()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public.bento_has_advanced_dms(new.id) then
    update public.instagram_dm_automations set enabled = false where user_id = new.id and enabled and (
      coalesce(array_length(excluded_keywords, 1), 0) > 0 or public_reply_enabled or opening_message is not null
      or confirmation_button_label is not null or email_capture_enabled or email_marketing_consent_enabled or follow_gate_enabled);
    update public.facebook_dm_automations set enabled = false where user_id = new.id and enabled and (
      coalesce(array_length(excluded_keywords, 1), 0) > 0 or public_reply_enabled or opening_message is not null
      or confirmation_button_label is not null or email_capture_enabled or email_marketing_consent_enabled);
    update public.twitter_dm_automations set enabled = false where user_id = new.id and enabled and coalesce(array_length(excluded_keywords, 1), 0) > 0;
  end if;
  return new;
end; $$;
create trigger pause_unentitled_auto_dms after update of plan_id, billing_catalog, trial_ends_at on public.profiles
for each row execute function public.pause_unentitled_auto_dms();
revoke all on function public.pause_unentitled_auto_dms() from public, anon, authenticated;

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
  if p_plan_id not in ('store', 'creator', 'creator_plus') then
    raise exception 'Complimentary access must use the Store, Creator or Creator Plus plan.';
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
  order by case subscription.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 else 3 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator', 'creator_plus') then
    v_paid_plan := 'free';
  end if;

  v_effective_plan := case
    when p_plan_id = 'creator_plus' or v_paid_plan = 'creator_plus' then 'creator_plus'
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
  set plan_id = v_effective_plan, is_pro = true, workspace_status = 'active', updated_at = now()
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
  order by case subscription.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 else 3 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator', 'creator_plus') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'),
    workspace_status = case when billing_catalog='legacy' or trial_ends_at>now() or (trial_ends_at is null and v_paid_plan<>'free') then 'active' else 'locked' end, updated_at = now()
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
  order by case subscription.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 else 3 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator', 'creator_plus') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'),
    workspace_status = case when billing_catalog='legacy' or trial_ends_at>now() or (trial_ends_at is null and v_paid_plan<>'free') then 'active' else 'locked' end, updated_at = now()
  where id = v_user_id;
end;
$$;


-- Restrictive policies close direct browser API writes as well as UI entry points.
create or replace function public.bento_has_hosted_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bento_instance_settings where edition = 'self_hosted')
    or exists (select 1 from public.profiles p where p.id = p_user_id and (
      p.billing_catalog = 'legacy' or p.trial_ends_at > now()
      or (p.trial_ends_at is null and p.plan_id in ('store', 'creator', 'creator_plus'))
    ));
$$;
revoke all on function public.bento_has_hosted_access(uuid) from public, anon;
grant execute on function public.bento_has_hosted_access(uuid) to authenticated, service_role;

create or replace function public.bento_has_brain_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bento_instance_settings where edition = 'self_hosted')
    or exists (select 1 from public.profiles p where p.id = p_user_id and (
      p.trial_ends_at > now() or (p.trial_ends_at is null and (
        p.plan_id = 'creator_plus' or (p.plan_id = 'creator' and p.billing_catalog = 'legacy')
      ))
    ));
$$;
revoke all on function public.bento_has_brain_access(uuid) from public, anon;
grant execute on function public.bento_has_brain_access(uuid) to authenticated, service_role;

create policy brain_catalog_access on public.creator_brain_items as restrictive for all to authenticated
using (public.bento_has_brain_access(user_id)) with check (public.bento_has_brain_access(user_id));

do $$ declare t text; begin
  foreach t in array array['blocks', 'pages', 'social_posts', 'social_posting_schedules', 'instagram_dm_automations', 'facebook_dm_automations', 'twitter_dm_automations'] loop
    execute format('create policy hosted_insert on public.%I as restrictive for insert to authenticated with check (public.bento_has_hosted_access(user_id))', t);
    execute format('create policy hosted_update on public.%I as restrictive for update to authenticated using (public.bento_has_hosted_access(user_id)) with check (public.bento_has_hosted_access(user_id))', t);
    execute format('create policy hosted_delete on public.%I as restrictive for delete to authenticated using (public.bento_has_hosted_access(user_id))', t);
  end loop;
end; $$;
notify pgrst, 'reload schema';

-- Active complimentary grants remain valid even after an older trial expired.
create or replace function public.bento_has_creator_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.bento_instance_settings where edition = 'self_hosted')
    or exists(select 1 from public.profiles p where p.id = p_user_id and
      (p.trial_ends_at > now() or (p.trial_ends_at is null and p.plan_id in ('creator','creator_plus'))))
    or exists(select 1 from public.complimentary_plan_grants g where g.user_id=p_user_id and g.status='active' and g.expires_at>now() and g.plan_id in ('creator','creator_plus'));
$$;
revoke all on function public.bento_has_creator_access(uuid) from public, anon;
grant execute on function public.bento_has_creator_access(uuid) to authenticated, service_role;

create or replace function public.bento_has_hosted_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.bento_instance_settings where edition='self_hosted')
    or exists(select 1 from public.profiles p where p.id=p_user_id and
      (p.billing_catalog='legacy' or p.trial_ends_at>now() or (p.trial_ends_at is null and p.plan_id in ('store','creator','creator_plus'))))
    or exists(select 1 from public.complimentary_plan_grants g where g.user_id=p_user_id and g.status='active' and g.expires_at>now());
$$;
create or replace function public.bento_has_brain_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.bento_instance_settings where edition='self_hosted')
    or exists(select 1 from public.profiles p where p.id=p_user_id and
      (p.trial_ends_at>now() or (p.trial_ends_at is null and (p.plan_id='creator_plus' or (p.plan_id='creator' and p.billing_catalog='legacy')))))
    or exists(select 1 from public.complimentary_plan_grants g join public.profiles p on p.id=g.user_id where g.user_id=p_user_id and g.status='active' and g.expires_at>now() and (g.plan_id='creator_plus' or (g.plan_id='creator' and p.billing_catalog='legacy')));
$$;
create or replace function public.bento_has_advanced_dms(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.bento_has_creator_access(p_user_id)
    or exists(select 1 from public.profiles p where p.id=p_user_id and p.billing_catalog='legacy' and p.plan_id='store' and p.trial_ends_at is null);
$$;

-- Direct authenticated writes and security-definer scheduler RPCs share the same plan gate.
create or replace function public.enforce_creator_scheduler_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() = 'service_role' then return new; end if;
  if not public.bento_has_creator_access(new.user_id) then raise exception 'Post Scheduler requires Creator or Creator Plus.'; end if;
  return new;
end; $$;
create trigger enforce_creator_scheduler_access before insert or update on public.social_posts
for each row execute function public.enforce_creator_scheduler_access();
create trigger enforce_creator_schedule_access before insert or update on public.social_posting_schedules
for each row execute function public.enforce_creator_scheduler_access();
revoke all on function public.enforce_creator_scheduler_access() from public, anon, authenticated;

create or replace function public.email_marketing_contact_limit(p_creator_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare p public.profiles; s public.subscriptions;
begin
  select * into p from public.profiles where id=p_creator_id for update;
  select * into s from public.subscriptions where user_id=p_creator_id for update;
  if exists(select 1 from public.bento_instance_settings where edition='self_hosted') then return 2147483647; end if;
  if public.bento_has_creator_access(p_creator_id) then
    if s.status::text in ('active','trialing') and s.plan_id in ('creator','creator_plus') then return coalesce(s.contact_tier_contacts,500); end if;
    return 500;
  end if;
  if p.plan_id='store' and public.bento_has_hosted_access(p_creator_id) then return 500; end if;
  return 0;
end; $$;

CREATE OR REPLACE FUNCTION public.email_marketing_capacity(p_creator_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  creator_profile public.profiles%rowtype;
  creator_plan text;
  contact_limit integer;
  subscribed_count bigint;
begin
  select *
  into creator_profile
  from public.profiles profile
  where profile.id = p_creator_id
  for update;

  if creator_profile.id is null then
    raise exception 'Creator profile was not found';
  end if;

  perform 1
  from public.subscriptions subscription
  where subscription.user_id = p_creator_id
  for update;

  creator_plan := case when public.bento_has_creator_access(p_creator_id) then case when creator_profile.plan_id='creator_plus' or creator_profile.trial_ends_at>now() then 'creator_plus' else 'creator' end when public.bento_has_hosted_access(p_creator_id) and creator_profile.plan_id='store' then 'store' else 'free' end;

  contact_limit := public.email_marketing_contact_limit(p_creator_id);

  select count(*)
  into subscribed_count
  from public.audience_contacts contact
  where contact.creator_id = p_creator_id
    and contact.marketing_status = 'subscribed';

  return jsonb_build_object(
    'plan', creator_plan,
    'limit', contact_limit,
    'subscribed', subscribed_count,
    'remaining', greatest(contact_limit::bigint - subscribed_count, 0),
    'over_limit', subscribed_count > contact_limit
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_audience_campaign_recipients_with_capacity(p_campaign_id uuid)
 RETURNS TABLE(contact_id uuid, email text, name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_creator_id uuid;
  creator_profile public.profiles%rowtype;
  creator_plan text;
  contact_limit integer;
  subscribed_count bigint;
begin
  select campaign.creator_id
  into v_creator_id
  from public.audience_campaigns campaign
  where campaign.id = p_campaign_id
    and campaign.delivery_status = 'sending';

  if v_creator_id is null then
    return;
  end if;

  select *
  into creator_profile
  from public.profiles profile
  where profile.id = v_creator_id
  for update;

  if creator_profile.id is null then
    raise exception 'Campaign creator profile was not found';
  end if;

  perform 1
  from public.subscriptions subscription
  where subscription.user_id = v_creator_id
  for update;

  creator_plan := creator_profile.plan_id;

  if not public.bento_has_creator_access(v_creator_id) then
    raise exception using
      errcode = 'P0001',
      message = 'Newsletter requires Creator or Creator Plus.';
  end if;

  contact_limit := public.email_marketing_contact_limit(v_creator_id);

  select count(*)
  into subscribed_count
  from public.audience_contacts contact
  where contact.creator_id = v_creator_id
    and contact.marketing_status = 'subscribed';

  if subscribed_count > contact_limit then
    raise exception using
      errcode = 'P0001',
      message = 'Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.',
      detail = jsonb_build_object(
        'creator_id', v_creator_id,
        'subscribed', subscribed_count,
        'limit', contact_limit
      )::text;
  end if;

  return query
  select prepared.contact_id, prepared.email, prepared.name
  from public.prepare_audience_campaign_recipients(p_campaign_id) prepared;
end;
$function$;


-- Billing recovery and owner data export remain readable when hosted access is
-- locked. Existing active-workspace mutation policies are deliberately unchanged.
create or replace function public.bento_owns_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_memberships m
    where m.workspace_id=p_workspace_id and m.auth_user_id=auth.uid()
      and m.role='owner' and m.status='active');
$$;
revoke all on function public.bento_owns_workspace(uuid) from public, anon;
grant execute on function public.bento_owns_workspace(uuid) to authenticated, service_role;
create policy owner_recovery_profile_read on public.profiles for select to authenticated
using (public.bento_owns_workspace(id));
create policy owner_recovery_subscription_read on public.subscriptions for select to authenticated
using (public.bento_owns_workspace(user_id));
