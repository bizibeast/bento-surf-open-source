-- Preserve advanced automation drafts on downgrade, but never let Free run them.
create or replace function public.enforce_instagram_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.enabled
     and coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
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

create or replace function public.enforce_facebook_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.enabled
     and coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
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

create or replace function public.enforce_twitter_auto_dm_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.enabled
     and coalesce((select plan_id from public.profiles where id = new.user_id), 'free') = 'free'
     and coalesce(array_length(new.excluded_keywords, 1), 0) > 0 then
    raise exception 'Advanced Auto DMs require the Store plan.';
  end if;
  return new;
end;
$$;

update public.instagram_dm_automations automation
set enabled = false, updated_at = now()
from public.profiles profile
where profile.id = automation.user_id
  and profile.plan_id = 'free'
  and automation.enabled
  and (
    coalesce(array_length(automation.excluded_keywords, 1), 0) > 0
    or automation.public_reply_enabled
    or automation.opening_message is not null
    or automation.confirmation_button_label is not null
    or automation.email_capture_enabled
    or automation.email_marketing_consent_enabled
    or automation.follow_gate_enabled
  );

update public.facebook_dm_automations automation
set enabled = false, updated_at = now()
from public.profiles profile
where profile.id = automation.user_id
  and profile.plan_id = 'free'
  and automation.enabled
  and (
    coalesce(array_length(automation.excluded_keywords, 1), 0) > 0
    or automation.public_reply_enabled
    or automation.opening_message is not null
    or automation.confirmation_button_label is not null
    or automation.email_capture_enabled
    or automation.email_marketing_consent_enabled
  );

update public.twitter_dm_automations automation
set enabled = false, updated_at = now()
from public.profiles profile
where profile.id = automation.user_id
  and profile.plan_id = 'free'
  and automation.enabled
  and coalesce(array_length(automation.excluded_keywords, 1), 0) > 0;

revoke all on function public.enforce_instagram_auto_dm_plan()
  from public, anon, authenticated;
revoke all on function public.enforce_facebook_auto_dm_plan()
  from public, anon, authenticated;
revoke all on function public.enforce_twitter_auto_dm_plan()
  from public, anon, authenticated;
