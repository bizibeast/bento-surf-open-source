alter table public.newsletter_publications
  drop constraint newsletter_publications_creator_unique,
  add column is_default boolean not null default false,
  add column default_template_id text not null default 'editorial'
    check (default_template_id in ('editorial','minimal','bold-digest','product-launch','personal-note','weekly-roundup')),
  add constraint newsletter_publications_creator_slug_unique unique (creator_id, slug);

alter table public.audience_campaigns
  add column template_id text
  check (template_id is null or template_id in ('editorial','minimal','bold-digest','product-launch','personal-note','weekly-roundup'));

with ranked as (
  select id, row_number() over (partition by creator_id order by created_at, id) as position
  from public.newsletter_publications
)
update public.newsletter_publications publication
set is_default = true
from ranked
where ranked.id = publication.id and ranked.position = 1;

create unique index newsletter_publications_one_default_per_creator
  on public.newsletter_publications(creator_id)
  where is_default;

alter table public.audience_lists
  drop constraint audience_lists_creator_name_unique,
  add column publication_id uuid references public.newsletter_publications(id) on delete cascade;

create unique index audience_lists_creator_name_legacy_unique
  on public.audience_lists(creator_id, name)
  where publication_id is null;

create unique index audience_lists_publication_name_unique
  on public.audience_lists(publication_id, name)
  where publication_id is not null;

create index audience_lists_publication_idx
  on public.audience_lists(publication_id, created_at desc)
  where publication_id is not null;

create index audience_campaigns_publication_idx
  on public.audience_campaigns(publication_id, created_at desc)
  where publication_id is not null;

alter table public.audience_consent_events
  add column idempotency_key text
  check (idempotency_key is null or length(idempotency_key) between 1 and 200);

create unique index audience_consent_events_creator_idempotency_unique
  on public.audience_consent_events(creator_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.commerce_validate_audience_list_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  publication_creator_id uuid;
begin
  if new.publication_id is null then
    return new;
  end if;

  select publication.creator_id into publication_creator_id
  from public.newsletter_publications publication
  where publication.id = new.publication_id;

  if publication_creator_id is null
    or publication_creator_id is distinct from new.creator_id
  then
    raise exception 'Invalid audience list publication';
  end if;

  return new;
end;
$$;

create trigger audience_lists_validate_publication
before insert or update of creator_id, publication_id on public.audience_lists
for each row execute function public.commerce_validate_audience_list_publication();

create or replace function public.commerce_validate_newsletter_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
  list_row public.audience_lists%rowtype;
begin
  if new.list_id is not null then
    select * into list_row
    from public.audience_lists
    where id = new.list_id;

    if list_row.id is null
      or list_row.creator_id is distinct from new.creator_id
      or list_row.publication_id is distinct from new.publication_id
    then
      raise exception 'Invalid campaign audience list';
    end if;
  end if;

  if new.kind = 'broadcast' then
    if new.public_slug is not null
      or new.web_visibility <> 'private'
      or new.published_at is not null
    then
      raise exception 'Broadcast campaigns cannot use newsletter publication fields';
    end if;

    if new.publication_id is null then
      return new;
    end if;
  elsif new.publication_id is null then
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

  if new.kind = 'newsletter' then
    if new.web_visibility <> 'private' and new.public_slug is null then
      raise exception 'Public newsletter posts require a slug';
    end if;
    if new.web_visibility = 'paid' and publication_row.paid_product_id is null then
      raise exception 'Paid newsletter posts require a linked product';
    end if;
  end if;

  return new;
end;
$$;

drop trigger audience_campaigns_validate_newsletter
on public.audience_campaigns;

create trigger audience_campaigns_validate_newsletter
before insert or update of creator_id, kind, publication_id, list_id, public_slug, content, web_visibility, published_at
on public.audience_campaigns
for each row execute function public.commerce_validate_newsletter_campaign();

drop policy audience_lists_owner_all on public.audience_lists;
create policy audience_lists_owner_all on public.audience_lists
for all to authenticated
using (
  (select auth.uid()) = creator_id
  and (
    publication_id is null
    or exists (
      select 1 from public.newsletter_publications publication
      where publication.id = publication_id
        and publication.creator_id = (select auth.uid())
    )
  )
)
with check (
  (select auth.uid()) = creator_id
  and (
    publication_id is null
    or exists (
      select 1 from public.newsletter_publications publication
      where publication.id = publication_id
        and publication.creator_id = (select auth.uid())
    )
  )
);

revoke all on function public.commerce_validate_audience_list_publication()
from public, anon, authenticated;

create or replace function public.set_default_newsletter_publication(
  p_creator_id uuid,
  p_publication_id uuid
)
returns public.newsletter_publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_creator_id::text, 0)
  );

  perform 1
  from public.newsletter_publications publication
  where publication.creator_id = p_creator_id
    and publication.status <> 'archived'
  order by publication.id
  for update;

  select * into publication_row
  from public.newsletter_publications publication
  where publication.id = p_publication_id
    and publication.creator_id = p_creator_id
    and publication.status <> 'archived';

  if publication_row.id is null then
    raise exception 'Newsletter publication not found';
  end if;

  update public.newsletter_publications
  set is_default = false
  where creator_id = p_creator_id
    and is_default;

  update public.newsletter_publications
  set is_default = true
  where id = p_publication_id
    and creator_id = p_creator_id
    and status <> 'archived'
  returning * into publication_row;

  return publication_row;
end;
$$;

create or replace function public.archive_newsletter_publication(
  p_creator_id uuid,
  p_publication_id uuid,
  p_confirmation text
)
returns public.newsletter_publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
  active_count bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_creator_id::text, 0)
  );

  perform 1
  from public.newsletter_publications publication
  where publication.creator_id = p_creator_id
    and publication.status <> 'archived'
  order by publication.id
  for update;

  select * into publication_row
  from public.newsletter_publications publication
  where publication.id = p_publication_id
    and publication.creator_id = p_creator_id
    and publication.status <> 'archived';

  if publication_row.id is null then
    raise exception 'Newsletter publication not found';
  end if;
  if p_confirmation is distinct from publication_row.title then
    raise exception 'Type the publication title exactly to archive it';
  end if;
  if publication_row.is_default then
    raise exception 'Choose another default publication before archiving this one';
  end if;

  select count(*) into active_count
  from public.newsletter_publications publication
  where publication.creator_id = p_creator_id
    and publication.status <> 'archived';
  if active_count <= 1 then
    raise exception 'The only publication cannot be archived';
  end if;

  update public.newsletter_publications
  set status = 'archived'
  where id = p_publication_id
    and creator_id = p_creator_id
    and status <> 'archived'
    and not is_default
  returning * into publication_row;

  return publication_row;
end;
$$;

revoke all on function public.set_default_newsletter_publication(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.set_default_newsletter_publication(uuid, uuid) to service_role;

revoke all on function public.archive_newsletter_publication(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.archive_newsletter_publication(uuid, uuid, text) to service_role;

create or replace function public.prepare_audience_campaign_recipients(
  p_campaign_id uuid
)
returns table(contact_id uuid, email text, name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  campaign public.audience_campaigns%rowtype;
begin
  select *
  into campaign
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
            campaign.publication_id is null
            or (
              publication.status <> 'archived'
              and subscription.status = 'subscribed'
              and subscription.email_enabled
            )
          )
          and (
            campaign.list_id is null
            or exists (
              select 1
              from public.audience_list_members member
              join public.audience_lists audience_list
                on audience_list.id = member.list_id
              where member.list_id = campaign.list_id
                and member.contact_id = contact.id
                and audience_list.creator_id = campaign.creator_id
                and audience_list.publication_id is not distinct from campaign.publication_id
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
      select 1
      from eligible_contacts eligible
      where eligible.id = recipient.contact_id
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
          campaign.publication_id is null
          or (
            publication.status <> 'archived'
            and subscription.status = 'subscribed'
            and subscription.email_enabled
          )
        )
        and (
          campaign.list_id is null
          or exists (
            select 1
            from public.audience_list_members member
            join public.audience_lists audience_list
              on audience_list.id = member.list_id
            where member.list_id = campaign.list_id
              and member.contact_id = contact.id
              and audience_list.creator_id = campaign.creator_id
              and audience_list.publication_id is not distinct from campaign.publication_id
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
          campaign.publication_id is null
          or (
            publication.status <> 'archived'
            and subscription.status = 'subscribed'
            and subscription.email_enabled
          )
        )
        and (
          campaign.list_id is null
          or exists (
            select 1
            from public.audience_list_members member
            join public.audience_lists audience_list
              on audience_list.id = member.list_id
            where member.list_id = campaign.list_id
              and member.contact_id = contact.id
              and audience_list.creator_id = campaign.creator_id
              and audience_list.publication_id is not distinct from campaign.publication_id
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

revoke all on function public.prepare_audience_campaign_recipients(uuid)
from public, anon, authenticated;

grant execute on function public.prepare_audience_campaign_recipients(uuid) to service_role;

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
      if campaign_record.publication_id is null then
        authorized := true;
      else
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

        authorized := publication_record.id is not null
          and publication_record.status <> 'archived'
          and subscription_record.status = 'subscribed'
          and subscription_record.email_enabled;
      end if;

      if authorized and campaign_record.list_id is not null then
        select member.* into list_member_record
        from public.audience_list_members member
        join public.audience_lists audience_list
          on audience_list.id = member.list_id
        where member.list_id = campaign_record.list_id
          and member.contact_id = contact_record.id
          and audience_list.creator_id = campaign_record.creator_id
          and audience_list.publication_id is not distinct from campaign_record.publication_id
        for update of member, audience_list;
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

revoke all on function public.authorize_audience_campaign_delivery(uuid)
from public, anon, authenticated;

grant execute on function public.authorize_audience_campaign_delivery(uuid) to service_role;

create or replace function public.unsubscribe_public_newsletter_subscriptions(
  p_creator_id uuid,
  p_publication_id uuid,
  p_subscribers jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected record;
  matched_subscription_id uuid;
  matched_contact_email text;
  subscription_ids uuid[] := '{}';
  subscriber_emails text[] := '{}';
  affected_campaign_id uuid;
begin
  if jsonb_typeof(p_subscribers) is distinct from 'array' or jsonb_array_length(p_subscribers) = 0 then
    raise exception 'Invalid newsletter subscriber batch';
  end if;

  perform 1
  from public.newsletter_publications publication
  where publication.id = p_publication_id
    and publication.creator_id = p_creator_id
    and publication.status <> 'archived'
  for update;
  if not found then
    raise exception 'Newsletter publication not found';
  end if;

  for selected in
    select subscription_id, lower(trim(email)) as email
    from jsonb_to_recordset(p_subscribers) as item(subscription_id uuid, email text)
  loop
    if selected.subscription_id is null
      or selected.email = ''
      or length(selected.email) > 254
      or selected.email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      or selected.subscription_id = any(subscription_ids)
    then
      raise exception 'Invalid newsletter subscriber batch';
    end if;

    select subscription.id, contact.email_normalized
    into matched_subscription_id, matched_contact_email
    from public.newsletter_subscriptions subscription
    join public.audience_contacts contact on contact.id = subscription.contact_id
    where subscription.id = selected.subscription_id
      and subscription.publication_id = p_publication_id
      and contact.creator_id = p_creator_id
    for update of subscription, contact;
    if matched_subscription_id is null or matched_contact_email is distinct from selected.email then
      raise exception 'Invalid newsletter subscriber batch';
    end if;
    subscription_ids := array_append(subscription_ids, selected.subscription_id);
    subscriber_emails := array_append(subscriber_emails, selected.email);
  end loop;

  update public.newsletter_subscriptions subscription
  set status = 'unsubscribed', email_enabled = false, unsubscribed_at = now()
  where subscription.id = any(subscription_ids)
    and subscription.publication_id = p_publication_id;

  update public.email_outbox outbox
  set status = 'suppressed', last_error = 'Newsletter subscription email disabled.', updated_at = now()
  where outbox.category = 'marketing'
    and outbox.status in ('pending', 'processing')
    and outbox.payload ->> 'newsletterPublicationId' = p_publication_id::text
    and exists (
      select 1
      from unnest(subscription_ids, subscriber_emails) as selected(subscription_id, email)
      where outbox.recipient_email = selected.email
        and outbox.payload ->> 'newsletterSubscriptionId' = selected.subscription_id::text
    );

  update public.audience_campaign_recipients recipient
  set status = 'suppressed', skip_reason = 'Newsletter subscription email disabled.', updated_at = now()
  from public.email_outbox outbox
  where recipient.email_outbox_id = outbox.id
    and outbox.payload ->> 'newsletterPublicationId' = p_publication_id::text
    and exists (
      select 1
      from unnest(subscription_ids, subscriber_emails) as selected(subscription_id, email)
      where outbox.recipient_email = selected.email
        and outbox.payload ->> 'newsletterSubscriptionId' = selected.subscription_id::text
    );

  for affected_campaign_id in
    select distinct recipient.campaign_id
    from public.audience_campaign_recipients recipient
    join public.email_outbox outbox on outbox.id = recipient.email_outbox_id
    where outbox.payload ->> 'newsletterPublicationId' = p_publication_id::text
      and outbox.payload ->> 'newsletterSubscriptionId' = any(
        array(select id::text from unnest(subscription_ids) as id)
      )
  loop
    perform public.refresh_audience_campaign_delivery(affected_campaign_id);
  end loop;

  return cardinality(subscription_ids);
end;
$$;

revoke all on function public.unsubscribe_public_newsletter_subscriptions(uuid, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.unsubscribe_public_newsletter_subscriptions(uuid, uuid, jsonb) to service_role;

create or replace function public.get_publication_audience_paid_access(
  p_creator_id uuid,
  p_publication_id uuid,
  p_contact_ids uuid[]
)
returns table(contact_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select distinct contact.id
  from public.newsletter_publications publication
  join public.audience_contacts contact
    on contact.id = any(p_contact_ids)
    and contact.creator_id = p_creator_id
  join public.commerce_access_grants access
    on access.creator_id = p_creator_id
    and access.product_id = publication.paid_product_id
    and lower(btrim(access.buyer_email)) = contact.email_normalized
    and access.status = 'active'
    and (access.expires_at is null or access.expires_at > now())
  where publication.id = p_publication_id
    and publication.creator_id = p_creator_id
    and publication.status <> 'archived';
end;
$$;

revoke all on function public.get_publication_audience_paid_access(uuid, uuid, uuid[])
from public, anon, authenticated;
grant execute on function public.get_publication_audience_paid_access(uuid, uuid, uuid[]) to service_role;
