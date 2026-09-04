create index if not exists audience_contacts_creator_subscribed_idx
  on public.audience_contacts(creator_id)
  where marketing_status = 'subscribed';

create or replace function public.email_marketing_contact_limit(p_creator_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator_profile public.profiles%rowtype;
  creator_plan text;
  current_subscription public.subscriptions%rowtype;
begin
  select *
  into creator_profile
  from public.profiles profile
  where profile.id = p_creator_id
  for update;

  select *
  into current_subscription
  from public.subscriptions subscription
  where subscription.user_id = p_creator_id
  for update;

  creator_plan := creator_profile.plan_id;

  return case
    when creator_plan = 'free' then 0
    when creator_plan = 'store' then 500
    when creator_plan = 'creator'
      and current_subscription.plan_id = 'creator'
      and current_subscription.status::text in ('active', 'trialing', 'past_due')
      then coalesce(current_subscription.contact_tier_contacts, 500)
    when creator_plan = 'creator' then 500
    else 0
  end;
end;
$$;

revoke all on function public.email_marketing_contact_limit(uuid)
  from public, anon, authenticated;

create or replace function public.commerce_apply_audience_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator_profile public.profiles%rowtype;
  current_contact public.audience_contacts%rowtype;
  contact_limit integer;
  subscribed_count bigint;
begin
  select *
  into creator_profile
  from public.profiles profile
  where profile.id = new.creator_id
  for update;

  if creator_profile.id is null then
    raise exception 'Audience creator profile was not found';
  end if;

  perform 1
  from public.subscriptions subscription
  where subscription.user_id = new.creator_id
  for update;

  select *
  into current_contact
  from public.audience_contacts contact
  where contact.id = new.contact_id
    and contact.creator_id = new.creator_id
  for update;

  if current_contact.id is null then
    raise exception 'Audience contact does not belong to creator';
  end if;

  if new.status = 'subscribed'
    and current_contact.marketing_status is distinct from 'subscribed' then
    contact_limit := public.email_marketing_contact_limit(new.creator_id);

    select count(*)
    into subscribed_count
    from public.audience_contacts contact
    where contact.creator_id = new.creator_id
      and contact.marketing_status = 'subscribed'
      and contact.id <> new.contact_id;

    if subscribed_count >= contact_limit then
      raise exception using
        errcode = 'P0001',
        message = 'Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.',
        detail = jsonb_build_object(
          'creator_id', new.creator_id,
          'subscribed', subscribed_count,
          'limit', contact_limit
        )::text;
    end if;
  end if;

  update public.audience_contacts
  set marketing_consent = new.status = 'subscribed',
      marketing_status = new.status,
      marketing_consented_at = case
        when new.status = 'subscribed' then new.occurred_at
        else marketing_consented_at
      end,
      marketing_unsubscribed_at = case
        when new.status = 'unsubscribed' then new.occurred_at
        else null
      end,
      updated_at = now()
  where id = new.contact_id
    and creator_id = new.creator_id;

  return new;
end;
$$;

revoke all on function public.commerce_apply_audience_consent()
  from public, anon, authenticated;

create or replace function public.email_marketing_capacity(p_creator_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  creator_plan := creator_profile.plan_id;

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
$$;

revoke all on function public.email_marketing_capacity(uuid)
  from public, anon, authenticated;
grant execute on function public.email_marketing_capacity(uuid) to service_role;

create or replace function public.prepare_audience_campaign_recipients_with_capacity(
  p_campaign_id uuid
)
returns table(contact_id uuid, email text, name text)
language plpgsql
security definer
set search_path = ''
as $$
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

  if creator_plan <> 'creator' then
    raise exception using
      errcode = 'P0001',
      message = 'Email Marketing requires the Creator plan.';
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
$$;

revoke all on function public.prepare_audience_campaign_recipients_with_capacity(uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_audience_campaign_recipients_with_capacity(uuid) to service_role;
