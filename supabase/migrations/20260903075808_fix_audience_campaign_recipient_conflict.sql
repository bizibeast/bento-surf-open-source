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
  on conflict on constraint audience_campaign_recipients_unique do nothing;

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
