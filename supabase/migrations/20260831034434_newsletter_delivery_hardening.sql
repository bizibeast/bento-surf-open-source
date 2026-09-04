alter table public.audience_campaigns
  add column if not exists delivery_status text not null default 'draft',
  add column if not exists delivery_error text;

update public.audience_campaigns
set delivery_status = case
  when status in ('scheduled', 'sending', 'sent', 'canceled') then status
  else 'draft'
end;

alter table public.audience_campaigns
  drop constraint if exists audience_campaigns_delivery_status_check,
  add constraint audience_campaigns_delivery_status_check
    check (delivery_status in ('draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'));

alter table public.audience_campaigns
  drop constraint if exists audience_campaigns_status_check,
  add constraint audience_campaigns_status_check
    check (status in ('draft', 'published', 'scheduled', 'sending', 'sent', 'failed', 'canceled'));

alter table public.audience_campaign_recipients
  drop constraint if exists audience_campaign_recipients_status_check,
  add constraint audience_campaign_recipients_status_check
    check (status in (
      'pending', 'queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'skipped'
    ));

create index if not exists audience_campaigns_due_delivery_idx
  on public.audience_campaigns(delivery_status, scheduled_at, created_at)
  where delivery_status in ('scheduled', 'sending');

create index if not exists audience_campaign_recipients_outbox_idx
  on public.audience_campaign_recipients(email_outbox_id)
  where email_outbox_id is not null;

create table public.email_marketing_send_reservations (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.audience_campaigns(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  recipient_count integer not null check (recipient_count > 0),
  created_at timestamptz not null default now(),
  unique (creator_id, campaign_id, period_start)
);

create index email_marketing_send_reservations_creator_period_idx
  on public.email_marketing_send_reservations(creator_id, period_start);

alter table public.email_marketing_send_reservations enable row level security;
revoke all on public.email_marketing_send_reservations from public, anon, authenticated;
grant all on public.email_marketing_send_reservations to service_role;

create or replace function public.claim_due_audience_campaigns(
  p_limit integer default 25,
  p_campaign_id uuid default null
)
returns setof public.audience_campaigns
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select campaign.id
    from public.audience_campaigns campaign
    where (p_campaign_id is null or campaign.id = p_campaign_id)
      and (
        (
          campaign.delivery_status = 'scheduled'
          and coalesce(campaign.scheduled_at, now()) <= now()
        )
        or (
          campaign.delivery_status = 'sending'
          and campaign.updated_at <= now() - interval '10 minutes'
        )
      )
    order by coalesce(campaign.scheduled_at, campaign.created_at), campaign.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.audience_campaigns campaign
  set delivery_status = 'sending',
      delivery_error = null,
      status = case when campaign.kind = 'broadcast' then 'sending' else campaign.status end,
      updated_at = now()
  from due
  where campaign.id = due.id
  returning campaign.*;
end;
$$;

create or replace function public.prepare_audience_campaign_recipients(p_campaign_id uuid)
returns table(contact_id uuid, email text, name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  campaign public.audience_campaigns%rowtype;
begin
  select * into campaign
  from public.audience_campaigns
  where id = p_campaign_id
    and delivery_status = 'sending';

  if campaign.id is null then
    return;
  end if;

  with eligible_contacts as (
    select contact.id
    from public.audience_contacts contact
    left join public.newsletter_subscriptions subscription
      on subscription.contact_id = contact.id
     and subscription.publication_id = campaign.publication_id
    left join public.newsletter_publications publication
      on publication.id = campaign.publication_id
     and publication.creator_id = campaign.creator_id
    where contact.creator_id = campaign.creator_id
      and contact.marketing_status = 'subscribed'
      and (
        (
          campaign.kind = 'broadcast'
          and (
            campaign.list_id is null
            or exists (
              select 1
              from public.audience_list_members member
              where member.list_id = campaign.list_id
                and member.contact_id = contact.id
            )
          )
        )
        or (
          campaign.kind = 'newsletter'
          and subscription.status = 'subscribed'
          and subscription.email_enabled
          and (
            campaign.web_visibility <> 'paid'
            or exists (
              select 1
              from public.commerce_access_grants access
              where access.creator_id = campaign.creator_id
                and access.product_id = publication.paid_product_id
                and lower(trim(access.buyer_email)) = contact.email_normalized
                and access.status = 'active'
                and (access.expires_at is null or access.expires_at > now())
            )
          )
        )
      )
  )
  update public.audience_campaign_recipients recipient
  set status = 'skipped',
      skip_reason = 'Recipient no longer eligible at delivery time.',
      updated_at = now()
  where recipient.campaign_id = campaign.id
    and recipient.status in ('pending', 'queued')
    and not exists (
      select 1 from eligible_contacts eligible where eligible.id = recipient.contact_id
    );

  insert into public.audience_campaign_recipients(campaign_id, contact_id, status)
  select campaign.id, contact.id, 'pending'
  from public.audience_contacts contact
  left join public.newsletter_subscriptions subscription
    on subscription.contact_id = contact.id
   and subscription.publication_id = campaign.publication_id
  left join public.newsletter_publications publication
    on publication.id = campaign.publication_id
   and publication.creator_id = campaign.creator_id
  where contact.creator_id = campaign.creator_id
    and contact.marketing_status = 'subscribed'
    and not exists (
      select 1
      from public.audience_campaign_recipients existing
      where existing.campaign_id = campaign.id
    )
    and (
      (
        campaign.kind = 'broadcast'
        and (
          campaign.list_id is null
          or exists (
            select 1
            from public.audience_list_members member
            where member.list_id = campaign.list_id
              and member.contact_id = contact.id
          )
        )
      )
      or (
        campaign.kind = 'newsletter'
        and subscription.status = 'subscribed'
        and subscription.email_enabled
        and (
          campaign.web_visibility <> 'paid'
          or exists (
            select 1
            from public.commerce_access_grants access
            where access.creator_id = campaign.creator_id
              and access.product_id = publication.paid_product_id
              and lower(trim(access.buyer_email)) = contact.email_normalized
              and access.status = 'active'
              and (access.expires_at is null or access.expires_at > now())
          )
        )
      )
    )
  on conflict (campaign_id, contact_id) do nothing;

  return query
  select contact.id, contact.email, contact.name
  from public.audience_campaign_recipients recipient
  join public.audience_contacts contact on contact.id = recipient.contact_id
  left join public.newsletter_subscriptions subscription
    on subscription.contact_id = contact.id
   and subscription.publication_id = campaign.publication_id
  left join public.newsletter_publications publication
    on publication.id = campaign.publication_id
   and publication.creator_id = campaign.creator_id
  where recipient.campaign_id = campaign.id
    and recipient.status in ('pending', 'queued')
    and contact.marketing_status = 'subscribed'
    and (
      (
        campaign.kind = 'broadcast'
        and (
          campaign.list_id is null
          or exists (
            select 1
            from public.audience_list_members member
            where member.list_id = campaign.list_id
              and member.contact_id = contact.id
          )
        )
      )
      or (
        campaign.kind = 'newsletter'
        and subscription.status = 'subscribed'
        and subscription.email_enabled
        and (
          campaign.web_visibility <> 'paid'
          or exists (
            select 1
            from public.commerce_access_grants access
            where access.creator_id = campaign.creator_id
              and access.product_id = publication.paid_product_id
              and lower(trim(access.buyer_email)) = contact.email_normalized
              and access.status = 'active'
              and (access.expires_at is null or access.expires_at > now())
          )
        )
      )
    )
  order by recipient.created_at, recipient.id;
end;
$$;

create or replace function public.reserve_email_marketing_sends(
  p_creator_id uuid,
  p_campaign_id uuid,
  p_recipient_count integer,
  p_limit integer default 10000
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  period date := date_trunc('month', now() at time zone 'UTC')::date;
  already_reserved public.email_marketing_send_reservations%rowtype;
  used_count bigint;
begin
  if p_recipient_count < 1 or p_limit < 1 then
    raise exception 'Invalid email marketing reservation';
  end if;

  if not exists (
    select 1 from public.audience_campaigns campaign
    where campaign.id = p_campaign_id and campaign.creator_id = p_creator_id
  ) then
    raise exception 'Campaign not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_creator_id::text || ':' || period::text, 0)
  );

  select * into already_reserved
  from public.email_marketing_send_reservations
  where creator_id = p_creator_id
    and campaign_id = p_campaign_id
    and period_start = period;

  if already_reserved.id is not null then
    return true;
  end if;

  select coalesce(sum(reservation.recipient_count), 0)
  into used_count
  from public.email_marketing_send_reservations reservation
  where reservation.creator_id = p_creator_id
    and reservation.period_start = period;

  if used_count + p_recipient_count > p_limit then
    raise exception 'Monthly email marketing send limit exceeded';
  end if;

  insert into public.email_marketing_send_reservations(
    campaign_id, creator_id, period_start, recipient_count
  ) values (p_campaign_id, p_creator_id, period, p_recipient_count);
  return true;
end;
$$;

create or replace function public.refresh_audience_campaign_delivery(p_campaign_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  campaign public.audience_campaigns%rowtype;
  recipient_count integer;
  terminal_count integer;
  accepted_count integer;
  next_status text;
begin
  select * into campaign
  from public.audience_campaigns
  where id = p_campaign_id;

  if campaign.id is null then
    return null;
  end if;

  select
    count(*),
    count(*) filter (
      where recipient.status in (
        'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'skipped'
      )
    ),
    count(*) filter (
      where recipient.status in ('sent', 'delivered', 'bounced', 'complained')
    )
  into recipient_count, terminal_count, accepted_count
  from public.audience_campaign_recipients recipient
  where recipient.campaign_id = p_campaign_id;

  if recipient_count = 0 or terminal_count <> recipient_count then
    return campaign.delivery_status;
  end if;

  next_status := case when accepted_count > 0 then 'sent' else 'failed' end;
  update public.audience_campaigns current_campaign
  set delivery_status = next_status,
      status = case
        when current_campaign.kind = 'broadcast' then next_status
        else current_campaign.status
      end,
      sent_at = case
        when next_status = 'sent' then coalesce(current_campaign.sent_at, now())
        else current_campaign.sent_at
      end,
      delivery_error = case
        when next_status = 'failed' then 'No recipient email was provider-accepted.'
        else null
      end,
      updated_at = now()
  where current_campaign.id = p_campaign_id
    and current_campaign.delivery_status in ('sending', 'failed');
  return next_status;
end;
$$;

create or replace function public.authorize_audience_campaign_delivery(p_outbox_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  outbox_record public.email_outbox%rowtype;
  suppression_record public.email_suppressions%rowtype;
  recipient_record public.audience_campaign_recipients%rowtype;
  campaign_record public.audience_campaigns%rowtype;
  contact_record public.audience_contacts%rowtype;
  publication_record public.newsletter_publications%rowtype;
  subscription_record public.newsletter_subscriptions%rowtype;
  access_record public.commerce_access_grants%rowtype;
  list_member_record public.audience_list_members%rowtype;
  authorized boolean := false;
  suppression_reason text := 'Recipient no longer eligible at delivery time.';
begin
  select * into outbox_record
  from public.email_outbox
  where id = p_outbox_id
  for update;

  if outbox_record.id is null then
    return false;
  end if;

  select * into suppression_record
  from public.email_suppressions
  where email = lower(outbox_record.recipient_email)
  for update;

  select * into recipient_record
  from public.audience_campaign_recipients
  where email_outbox_id = p_outbox_id
  for update;

  if recipient_record.id is null then
    update public.email_outbox
    set status = 'suppressed',
        last_error = 'Campaign recipient linkage is incomplete.',
        updated_at = now()
    where id = p_outbox_id;
    return false;
  end if;

  select * into campaign_record
  from public.audience_campaigns
  where id = recipient_record.campaign_id
  for update;

  select * into contact_record
  from public.audience_contacts
  where id = recipient_record.contact_id
  for update;

  if campaign_record.id is not null
     and campaign_record.delivery_status = 'sending'
     and contact_record.id is not null
     and contact_record.creator_id = campaign_record.creator_id
     and contact_record.marketing_status = 'subscribed'
     and contact_record.email_normalized = lower(outbox_record.recipient_email)
     and suppression_record.email is null
     and outbox_record.event_key =
       'audience-campaign:' || campaign_record.id::text || ':' || contact_record.id::text
     and recipient_record.status in ('pending', 'queued') then
    if campaign_record.kind = 'broadcast' then
      if campaign_record.list_id is null then
        authorized := true;
      else
        select * into list_member_record
        from public.audience_list_members
        where list_id = campaign_record.list_id
          and contact_id = contact_record.id
        for update;
        authorized := list_member_record.list_id is not null;
      end if;
    elsif campaign_record.kind = 'newsletter' then
      select * into publication_record
      from public.newsletter_publications
      where id = campaign_record.publication_id
        and creator_id = campaign_record.creator_id
      for update;

      select * into subscription_record
      from public.newsletter_subscriptions
      where publication_id = campaign_record.publication_id
        and contact_id = contact_record.id
      for update;

      authorized := publication_record.status = 'published'
        and subscription_record.status = 'subscribed'
        and subscription_record.email_enabled;

      if authorized and campaign_record.web_visibility = 'paid' then
        select * into access_record
        from public.commerce_access_grants
        where creator_id = campaign_record.creator_id
          and product_id = publication_record.paid_product_id
          and lower(trim(buyer_email)) = contact_record.email_normalized
          and status = 'active'
          and (expires_at is null or expires_at > now())
        order by expires_at desc nulls first, created_at desc
        limit 1
        for update;
        authorized := access_record.id is not null;
      end if;
    end if;
  end if;

  if authorized then
    return true;
  end if;

  if suppression_record.email is not null then
    suppression_reason := 'Email is globally suppressed.';
  end if;

  update public.email_outbox
  set status = 'suppressed',
      last_error = suppression_reason,
      updated_at = now()
  where id = p_outbox_id;

  update public.audience_campaign_recipients
  set status = 'suppressed',
      skip_reason = suppression_reason,
      updated_at = now()
  where id = recipient_record.id
    and status in ('pending', 'queued');

  perform public.refresh_audience_campaign_delivery(campaign_record.id);
  return false;
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
      or (
        recipient.status = 'sent'
        and p_status in ('delivered', 'bounced', 'complained')
      )
      or (recipient.status = 'delivered' and p_status = 'complained')
    );
  get diagnostics updated_count = row_count;

  if campaign_id is not null then
    perform public.refresh_audience_campaign_delivery(campaign_id);
  end if;
  return updated_count;
end;
$$;

create or replace function public.skip_audience_campaign_recipients(
  p_campaign_id uuid,
  p_contact_ids uuid[],
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  skipped_count integer;
begin
  update public.audience_campaign_recipients recipient
  set status = 'skipped',
      skip_reason = left(coalesce(p_reason, 'Recipient was skipped.'), 1000),
      updated_at = now()
  where recipient.campaign_id = p_campaign_id
    and recipient.contact_id = any(coalesce(p_contact_ids, '{}'::uuid[]))
    and recipient.status in ('pending', 'queued');
  get diagnostics skipped_count = row_count;
  perform public.refresh_audience_campaign_delivery(p_campaign_id);
  return skipped_count;
end;
$$;

create or replace function public.link_audience_campaign_outbox(
  p_campaign_id uuid,
  p_links jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_count integer;
begin
  with links as (
    select *
    from jsonb_to_recordset(coalesce(p_links, '[]'::jsonb))
      as link(contact_id uuid, event_key text, outbox_id uuid)
  )
  update public.audience_campaign_recipients recipient
  set email_outbox_id = links.outbox_id,
      status = case
        when outbox.status = 'sent' then 'sent'
        when outbox.status = 'failed' then 'failed'
        when outbox.status = 'suppressed' then 'suppressed'
        else 'queued'
      end,
      skip_reason = case
        when outbox.status in ('failed', 'suppressed') then outbox.last_error
        else null
      end,
      updated_at = now()
  from links
  join public.email_outbox outbox
    on outbox.id = links.outbox_id
   and outbox.event_key = links.event_key
  where recipient.campaign_id = p_campaign_id
    and recipient.contact_id = links.contact_id
    and recipient.status in ('pending', 'queued')
    and links.event_key = 'audience-campaign:' || p_campaign_id::text || ':' || links.contact_id::text;

  get diagnostics linked_count = row_count;
  perform public.refresh_audience_campaign_delivery(p_campaign_id);
  return linked_count;
end;
$$;

create or replace function public.claim_email_outbox(p_limit integer default 25)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select id
    from public.email_outbox
    where (
        (status = 'pending' and available_at <= now())
        or (status = 'processing' and updated_at <= now() - interval '10 minutes')
      )
      and attempts < 5
    order by case when category = 'transactional' then 0 else 1 end,
      available_at,
      created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.email_outbox email
  set status = 'processing', attempts = email.attempts + 1, updated_at = now()
  from claimed
  where email.id = claimed.id
  returning email.*;
end;
$$;

revoke all on function public.claim_due_audience_campaigns(integer, uuid)
  from public, anon, authenticated;
revoke all on function public.prepare_audience_campaign_recipients(uuid)
  from public, anon, authenticated;
revoke all on function public.reserve_email_marketing_sends(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.refresh_audience_campaign_delivery(uuid)
  from public, anon, authenticated;
revoke all on function public.authorize_audience_campaign_delivery(uuid)
  from public, anon, authenticated;
revoke all on function public.update_audience_campaign_recipient_status(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.skip_audience_campaign_recipients(uuid, uuid[], text)
  from public, anon, authenticated;
revoke all on function public.link_audience_campaign_outbox(uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.claim_due_audience_campaigns(integer, uuid) to service_role;
grant execute on function public.prepare_audience_campaign_recipients(uuid) to service_role;
grant execute on function public.reserve_email_marketing_sends(uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.refresh_audience_campaign_delivery(uuid) to service_role;
grant execute on function public.authorize_audience_campaign_delivery(uuid) to service_role;
grant execute on function public.update_audience_campaign_recipient_status(uuid, text, text)
  to service_role;
grant execute on function public.skip_audience_campaign_recipients(uuid, uuid[], text)
  to service_role;
grant execute on function public.link_audience_campaign_outbox(uuid, jsonb) to service_role;
