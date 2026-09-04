create or replace function public.get_newsletter_publication_recipient_counts(
  p_creator_id uuid,
  p_publication_id uuid
)
returns table(list_id uuid, recipient_count bigint)
language sql
security definer
set search_path = ''
as $$
  with eligible as (
    select subscription.contact_id
    from public.newsletter_subscriptions subscription
    join public.audience_contacts contact on contact.id = subscription.contact_id
    join public.newsletter_publications publication on publication.id = subscription.publication_id
    where publication.id = p_publication_id
      and publication.creator_id = p_creator_id
      and publication.status <> 'archived'
      and subscription.status = 'subscribed'
      and subscription.email_enabled
      and contact.creator_id = p_creator_id
      and contact.marketing_status = 'subscribed'
  )
  select null::uuid, count(*)::bigint from eligible
  union all
  select audience_list.id, count(eligible.contact_id)::bigint
  from public.audience_lists audience_list
  left join public.audience_list_members member on member.list_id = audience_list.id
  left join eligible on eligible.contact_id = member.contact_id
  where audience_list.creator_id = p_creator_id
    and audience_list.publication_id = p_publication_id
  group by audience_list.id;
$$;

revoke all on function public.get_newsletter_publication_recipient_counts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_newsletter_publication_recipient_counts(uuid, uuid) to service_role;

alter table public.audience_campaigns
  add column if not exists publish_on_delivery boolean not null default false;

update public.audience_campaigns
set publish_on_delivery = true
where kind = 'newsletter'
  and status = 'draft'
  and delivery_status = 'scheduled';

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
          -- ponytail: publish-on-delivery has no claim token; reconcile a stuck Post
          -- explicitly after proving the original worker is dead.
          and not (campaign.kind = 'newsletter' and campaign.publish_on_delivery)
        )
      )
    order by coalesce(campaign.scheduled_at, campaign.created_at), campaign.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.audience_campaigns campaign
  set delivery_status = 'sending',
      delivery_error = null,
      status = case
        when campaign.kind = 'broadcast' then 'sending'
        when campaign.kind = 'newsletter' and campaign.publish_on_delivery then 'published'
        else campaign.status
      end,
      published_at = case
        when campaign.kind = 'newsletter' and campaign.publish_on_delivery
          then coalesce(campaign.published_at, now())
        else campaign.published_at
      end,
      updated_at = now()
  from due
  where campaign.id = due.id
  returning campaign.*;
end;
$$;
