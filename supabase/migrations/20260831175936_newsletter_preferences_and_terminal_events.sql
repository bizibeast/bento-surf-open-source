alter table public.audience_campaigns
  add column if not exists sender_postal_address text;

alter table public.audience_campaigns
  drop constraint if exists audience_campaigns_sender_postal_address_check,
  add constraint audience_campaigns_sender_postal_address_check check (
    sender_postal_address is null
    or length(trim(sender_postal_address)) between 1 and 500
  );

create or replace function public.commerce_validate_newsletter_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
begin
  if new.kind = 'broadcast' then
    if new.publication_id is not null
      or new.public_slug is not null
      or new.web_visibility <> 'private'
      or new.published_at is not null
    then
      raise exception 'Broadcast campaigns cannot use newsletter publication fields';
    end if;
    return new;
  end if;

  if new.publication_id is null then
    raise exception 'Newsletter campaigns require a publication';
  end if;

  select * into publication_row
  from public.newsletter_publications
  where id = new.publication_id;

  if publication_row.id is null
    or publication_row.creator_id is distinct from new.creator_id
  then
    raise exception 'Invalid newsletter publication';
  end if;
  if new.web_visibility <> 'private' and new.public_slug is null then
    raise exception 'Public newsletter issues require a slug';
  end if;
  if new.web_visibility = 'paid' and publication_row.paid_product_id is null then
    raise exception 'Paid newsletter issues require a linked product';
  end if;
  return new;
end;
$$;

create or replace function public.unsubscribe_public_newsletter_subscription(
  p_publication_id uuid,
  p_subscription_id uuid,
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscription_row public.newsletter_subscriptions%rowtype;
  contact_row public.audience_contacts%rowtype;
  affected_campaign_id uuid;
  publication_creator_id uuid;
  normalized_email text := lower(trim(p_email));
begin
  if normalized_email = '' or length(normalized_email) > 254 then
    return false;
  end if;

  select publication.creator_id into publication_creator_id
  from public.newsletter_publications publication
  where publication.id = p_publication_id
  for update;
  if publication_creator_id is null then
    return false;
  end if;

  select subscription.* into subscription_row
  from public.newsletter_subscriptions subscription
  where subscription.id = p_subscription_id
    and subscription.publication_id = p_publication_id
  for update of subscription;
  if subscription_row.id is null then
    return false;
  end if;

  select contact.* into contact_row
  from public.audience_contacts contact
  where contact.id = subscription_row.contact_id
    and contact.creator_id = publication_creator_id
    and contact.email_normalized = normalized_email
  for update;
  if contact_row.id is null then
    return false;
  end if;

  update public.newsletter_subscriptions subscription
  set status = 'unsubscribed',
      email_enabled = false,
      unsubscribed_at = now()
  where subscription.id = p_subscription_id
    and subscription.publication_id = p_publication_id;

  update public.email_outbox outbox
  set status = 'suppressed',
      last_error = 'Newsletter subscription email is disabled.',
      updated_at = now()
  where outbox.recipient_email = normalized_email
    and outbox.category = 'marketing'
    and outbox.status in ('pending', 'processing')
    and outbox.payload ->> 'newsletterPublicationId' = p_publication_id::text
    and outbox.payload ->> 'newsletterSubscriptionId' = p_subscription_id::text;

  for affected_campaign_id in
    update public.audience_campaign_recipients recipient
    set status = 'suppressed',
        skip_reason = 'Newsletter subscription email is disabled.',
        updated_at = now()
    from public.email_outbox outbox
    where recipient.email_outbox_id = outbox.id
      and outbox.recipient_email = normalized_email
      and outbox.payload ->> 'newsletterPublicationId' = p_publication_id::text
      and outbox.payload ->> 'newsletterSubscriptionId' = p_subscription_id::text
      and recipient.status in ('pending', 'queued')
    returning recipient.campaign_id
  loop
    perform public.refresh_audience_campaign_delivery(affected_campaign_id);
  end loop;

  return true;
end;
$$;

create or replace function public.update_audience_campaign_recipient_status(
  p_email_outbox_id uuid,
  p_status text,
  p_skip_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  campaign_id uuid;
  updated_count integer;
begin
  if p_status not in ('sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'skipped') then
    raise exception 'Invalid audience campaign recipient status';
  end if;
  select recipient.campaign_id into campaign_id
  from public.audience_campaign_recipients recipient
  where recipient.email_outbox_id = p_email_outbox_id;

  update public.audience_campaign_recipients recipient
  set status = p_status,
      skip_reason = case
        when p_status in ('failed', 'suppressed', 'skipped')
          then coalesce(p_skip_reason, recipient.skip_reason)
        else null
      end,
      updated_at = now()
  where recipient.email_outbox_id = p_email_outbox_id
    and (
      recipient.status = p_status
      or recipient.status in ('pending', 'queued')
      or (recipient.status = 'sent' and p_status in ('delivered', 'bounced', 'complained', 'failed', 'suppressed'))
      or (recipient.status = 'delivered' and p_status = 'complained')
    );
  get diagnostics updated_count = row_count;
  if campaign_id is not null then
    perform public.refresh_audience_campaign_delivery(campaign_id);
  end if;
  return updated_count;
end;
$$;

create or replace function public.claim_email_outbox(p_limit integer default 25)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with claimed as (
    select outbox.id
    from public.email_outbox outbox
    where (
        (outbox.status = 'pending' and outbox.available_at <= now())
        or (outbox.status = 'processing' and outbox.updated_at <= now() - interval '10 minutes')
      )
      and outbox.attempts < 5
    order by case when outbox.category = 'transactional' then 0 else 1 end,
      outbox.available_at,
      outbox.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.email_outbox outbox
  set status = 'processing',
      attempts = outbox.attempts + 1,
      updated_at = now()
  from claimed
  where outbox.id = claimed.id
  returning outbox.*;
end;
$$;

revoke all on function public.unsubscribe_public_newsletter_subscription(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.unsubscribe_public_newsletter_subscription(uuid, uuid, text) to service_role;
