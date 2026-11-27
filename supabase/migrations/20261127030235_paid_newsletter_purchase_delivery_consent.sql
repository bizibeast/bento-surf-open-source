-- A paid newsletter buys delivery of that publication, not creator-wide marketing.
-- Existing explicit opt-in continues to enroll the default marketing publication.
-- No historical consent/backfill is inferred by this migration.

create or replace function public.has_paid_newsletter_delivery_access(
  p_creator_id uuid, p_publication_id uuid, p_contact_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.audience_contacts contact
    join public.newsletter_subscriptions subscription on subscription.contact_id = contact.id
    join public.newsletter_publications publication on publication.id = subscription.publication_id
    join public.commerce_products product on product.id = publication.paid_product_id
    join public.commerce_access_grants access
      on access.creator_id = contact.creator_id and access.product_id = product.id
      and lower(trim(access.buyer_email)) = contact.email_normalized
    join public.commerce_orders original_order on original_order.id = access.order_id
    left join public.commerce_subscription_access current_access on current_access.access_grant_id = access.id
    join public.commerce_orders paid_order
      on paid_order.id = coalesce(current_access.funding_order_id,access.order_id)
    where contact.id = p_contact_id and contact.creator_id = p_creator_id
      and contact.marketing_status = 'unknown'
      and publication.id = p_publication_id and publication.creator_id = contact.creator_id
      and publication.status = 'published'
      and product.creator_id = publication.creator_id and product.kind::text = 'newsletter'
      and product.settings->>'newsletterPublicationId' = publication.id::text
      and subscription.status = 'subscribed' and subscription.email_enabled
      and subscription.consent_proof->>'purpose' = 'paid_newsletter_delivery'
      and subscription.consent_proof->>'publication_id' = publication.id::text
      and subscription.consent_proof->>'product_id' = product.id::text
      and access.status = 'active' and (access.expires_at is null or access.expires_at > now())
      and original_order.creator_id = product.creator_id and original_order.product_id = product.id
      and lower(trim(original_order.buyer_email)) = contact.email_normalized
      and (current_access.id is null or (
        current_access.status in ('active','cancel_at_period_end','past_due')
        and current_access.creator_id = product.creator_id and current_access.product_id = product.id
        and lower(trim(current_access.buyer_email)) = contact.email_normalized
        and current_access.provider = original_order.provider
        and current_access.provider_account_id = coalesce(original_order.provider_account_id,'')
        and current_access.provider_subscription_id = original_order.provider_subscription_id
      ))
      and paid_order.creator_id = product.creator_id and paid_order.product_id = product.id
      and lower(trim(paid_order.buyer_email)) = contact.email_normalized
      and paid_order.status in ('paid','partially_refunded') and paid_order.gross_amount > 0
      and paid_order.refunded_amount < paid_order.gross_amount
      and nullif(trim(paid_order.provider_payment_id),'') is not null
      and paid_order.provider in ('stripe','paypal','razorpay','dodo','creem','polar')
      and paid_order.provider = original_order.provider
      and paid_order.provider_account_id is not distinct from original_order.provider_account_id
      and (paid_order.id = original_order.id or (
        original_order.provider_subscription_id is not null
        and paid_order.provider_subscription_id = original_order.provider_subscription_id
      ))
  );
$$;
revoke all on function public.has_paid_newsletter_delivery_access(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.has_paid_newsletter_delivery_access(uuid,uuid,uuid) to service_role;

create or replace function public.email_marketing_contact_limit_snapshot(p_creator_id uuid)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles; s public.subscriptions;
begin
  select * into p from public.profiles where id=p_creator_id;
  select * into s from public.subscriptions where user_id=p_creator_id;
  if exists(select 1 from public.bento_instance_settings where edition='self_hosted') then return 2147483647; end if;
  if public.bento_has_creator_access(p_creator_id) then
    if s.status::text in ('active','trialing') and s.plan_id in ('creator','creator_plus') then return coalesce(s.contact_tier_contacts,500); end if;
    return 500;
  end if;
  if p.plan_id='store' and public.bento_has_hosted_access(p_creator_id) then return 500; end if;
  return 0;
end; $$;
revoke all on function public.email_marketing_contact_limit_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.email_marketing_contact_limit_snapshot(uuid) to service_role;

-- Enrollment/sending retains the original locks; checkout preflight reads the
-- same canonical allowance without locks, reservations, or persistent changes.
create or replace function public.email_marketing_contact_limit(p_creator_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.profiles where id=p_creator_id for update;
  perform 1 from public.subscriptions where user_id=p_creator_id for update;
  return public.email_marketing_contact_limit_snapshot(p_creator_id);
end;
$$;
revoke all on function public.email_marketing_contact_limit(uuid) from public,anon,authenticated;

create or replace function public.count_email_delivery_contacts(
  p_creator_id uuid, p_exclude_contact_id uuid default null
)
returns bigint language sql stable security definer set search_path = '' as $$
  select count(*) from public.audience_contacts contact
  where contact.creator_id = p_creator_id and contact.id is distinct from p_exclude_contact_id
    and (contact.marketing_status = 'subscribed' or exists (
      select 1 from public.newsletter_subscriptions subscription
      where subscription.contact_id = contact.id
        and public.has_paid_newsletter_delivery_access(p_creator_id,subscription.publication_id,contact.id)
    ));
$$;
revoke all on function public.count_email_delivery_contacts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.count_email_delivery_contacts(uuid,uuid) to service_role;

create or replace function public.can_accept_paid_newsletter_checkout(p_product_id uuid,p_email text)
returns boolean language sql stable security definer set search_path='' as $$
  with candidate as materialized (
    select product.creator_id,publication.id as publication_id,contact.id as contact_id,
      contact.marketing_status,
      public.email_marketing_contact_limit_snapshot(product.creator_id) as contact_limit,
      public.count_email_delivery_contacts(product.creator_id) as contact_count
    from public.commerce_products product
    join public.newsletter_publications publication on publication.paid_product_id=product.id
      and publication.creator_id=product.creator_id
      and publication.id::text=product.settings->>'newsletterPublicationId'
    left join public.audience_contacts contact on contact.creator_id=product.creator_id
      and contact.email_normalized=lower(trim(p_email))
    where product.id=p_product_id and product.kind::text='newsletter' and product.status='published'
      and product.pricing_type::text='subscription' and product.price_amount>0
      and publication.status='published' and public.bento_has_creator_access(product.creator_id)
      and length(trim(p_email)) between 3 and 254
      and trim(p_email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  )
  select coalesce((select
    coalesce(candidate.marketing_status<>'unsubscribed',true)
    and not exists (
      select 1 from public.newsletter_subscriptions subscription
      where subscription.contact_id=candidate.contact_id and subscription.publication_id=candidate.publication_id
        and (subscription.status='unsubscribed' or not subscription.email_enabled)
    )
    and candidate.contact_limit>0 and candidate.contact_count<=candidate.contact_limit
    and (candidate.contact_count<candidate.contact_limit
      or candidate.marketing_status='subscribed' or exists (
        select 1 from public.newsletter_subscriptions subscription
        where subscription.contact_id=candidate.contact_id
          and public.has_paid_newsletter_delivery_access(candidate.creator_id,subscription.publication_id,candidate.contact_id)
      )) from candidate),false);
$$;
revoke all on function public.can_accept_paid_newsletter_checkout(uuid,text) from public,anon,authenticated;
grant execute on function public.can_accept_paid_newsletter_checkout(uuid,text) to service_role;

create or replace function public.guard_paid_newsletter_delivery_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare contact_record public.audience_contacts%rowtype; publication_creator uuid;
  contact_limit integer; other_contacts bigint;
begin
  if new.status <> 'subscribed' or not new.email_enabled
    or new.consent_proof->>'purpose' is distinct from 'paid_newsletter_delivery' then return new; end if;
  select creator_id into publication_creator from public.newsletter_publications where id=new.publication_id;
  if publication_creator is null then return new; end if;
  -- Serialize with ordinary marketing opt-ins before reading their shared allowance.
  perform 1 from public.profiles where id=publication_creator for update;
  contact_limit := public.email_marketing_contact_limit(publication_creator);
  select * into contact_record from public.audience_contacts where id=new.contact_id and creator_id=publication_creator;
  if contact_record.id is null or contact_record.marketing_status='unsubscribed' then return new; end if;
  if contact_record.marketing_status='subscribed' or exists (
    select 1 from public.newsletter_subscriptions subscription
    where subscription.contact_id=contact_record.id
      and public.has_paid_newsletter_delivery_access(publication_creator,subscription.publication_id,contact_record.id)
  ) then return new; end if;
  other_contacts := public.count_email_delivery_contacts(publication_creator,contact_record.id);
  if other_contacts >= contact_limit then
    raise exception using errcode='P0001',
      message='Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.',
      detail=jsonb_build_object('creator_id',publication_creator,'subscribed',other_contacts,'limit',contact_limit)::text;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_paid_newsletter_delivery_capacity() from public,anon,authenticated;
create trigger newsletter_subscriptions_paid_delivery_capacity
  before insert or update of publication_id,contact_id,status,email_enabled,consent_proof
  on public.newsletter_subscriptions for each row
  execute function public.guard_paid_newsletter_delivery_capacity();

create or replace function public.commerce_subscribe_paid_order_buyer_for_order(
  order_row public.commerce_orders
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  paid_order public.commerce_orders%rowtype;
  product_record public.commerce_products%rowtype;
  contact_record public.audience_contacts%rowtype;
  subscription_record public.newsletter_subscriptions%rowtype;
  paid_publication_id uuid;
  marketing_publication_id uuid;
  contact_row_id uuid;
  target_publication record;
  proof jsonb;
  subscription_source text;
  purchased_at timestamptz;
begin
  -- Reload the persisted order: a fabricated/stale composite is not consent.
  select * into paid_order from public.commerce_orders where id = order_row.id;
  if paid_order.id is null or paid_order.status <> 'paid'
    or paid_order.creator_id is null or nullif(trim(paid_order.buyer_email),'') is null then
    return;
  end if;
  purchased_at := coalesce(paid_order.paid_at,paid_order.updated_at,paid_order.created_at,now());
  select * into product_record from public.commerce_products
    where id = paid_order.product_id and creator_id = paid_order.creator_id;
  if product_record.id is null then return; end if;

  if product_record.kind::text = 'newsletter' then
    -- Signed, successful nonzero provider payments establish delivery intent.
    -- Never cast mutable JSON to uuid or fall back to the default publication.
    if paid_order.gross_amount <= 0 or paid_order.refunded_amount >= paid_order.gross_amount
      or nullif(trim(paid_order.provider_payment_id),'') is null
      or paid_order.provider not in ('stripe','paypal','razorpay','dodo','creem','polar') then return; end if;
    select publication.id into paid_publication_id from public.newsletter_publications publication
      where publication.id::text = product_record.settings->>'newsletterPublicationId'
        and publication.creator_id = paid_order.creator_id
        and publication.paid_product_id = product_record.id and publication.status <> 'archived';
    if paid_publication_id is null then return; end if;
  end if;

  if paid_order.metadata->>'newsletter_opt_in' = 'true' then
    select publication.id into marketing_publication_id from public.newsletter_publications publication
      where publication.creator_id = paid_order.creator_id and publication.status <> 'archived'
      order by publication.is_default desc,publication.created_at,publication.id limit 1;
  end if;
  if paid_publication_id is null and marketing_publication_id is null then return; end if;

  perform 1 from public.profiles where id=paid_order.creator_id for update;
  contact_row_id := public.commerce_upsert_audience_contact(paid_order.creator_id,
    paid_order.buyer_email,paid_order.buyer_name,'purchase_checkout',purchased_at);
  select * into contact_record from public.audience_contacts
    where id = contact_row_id and creator_id = paid_order.creator_id for update;
  if contact_record.id is null or contact_record.marketing_status = 'unsubscribed' then return; end if;

  for target_publication in
    select publication.id, bool_or(target.paid_delivery) as paid_delivery,
      bool_or(target.marketing) as marketing
    from (values (paid_publication_id,true,false),(marketing_publication_id,false,true))
      as target(id,paid_delivery,marketing)
    join public.newsletter_publications publication on publication.id = target.id
      and publication.creator_id = paid_order.creator_id
    group by publication.id order by publication.id
  loop
    select * into subscription_record from public.newsletter_subscriptions
      where publication_id = target_publication.id and contact_id = contact_record.id for update;
    if subscription_record.status = 'unsubscribed' or subscription_record.email_enabled is false then
      continue;
    end if;
    subscription_source := case when target_publication.paid_delivery
      then 'paid_newsletter_purchase' else 'purchase_checkout' end;
    proof := jsonb_build_object('order_id',paid_order.id,'product_id',paid_order.product_id,
      'publication_id',target_publication.id,'disclosure',case when target_publication.paid_delivery
        then 'paid_newsletter_purchase' else 'purchase_newsletter_subscription' end);
    if target_publication.paid_delivery then
      proof := proof || jsonb_build_object('purpose','paid_newsletter_delivery');
    end if;
    begin
      if target_publication.marketing then
        -- Only the separately checked creator-update opt-in changes global consent.
        insert into public.audience_consent_events(creator_id,contact_id,status,source,proof,occurred_at,idempotency_key)
        values(paid_order.creator_id,contact_record.id,'subscribed','purchase_checkout',
          jsonb_build_object('order_id',paid_order.id,'product_id',paid_order.product_id,
            'publication_id',target_publication.id,'disclosure','purchase_newsletter_subscription'),
          purchased_at,'source:purchase_checkout:order:'||paid_order.id::text)
        on conflict (creator_id,idempotency_key) where idempotency_key is not null do nothing;
      end if;
      insert into public.newsletter_subscriptions(publication_id,contact_id,status,email_enabled,
        source,consent_proof,subscribed_at,unsubscribed_at,confirmation_nonce)
      values(target_publication.id,contact_record.id,'subscribed',true,subscription_source,proof,purchased_at,null,null)
      on conflict (publication_id,contact_id) do update set
        status = 'subscribed', source = excluded.source,
        consent_proof = public.newsletter_subscriptions.consent_proof || excluded.consent_proof,
        subscribed_at = coalesce(public.newsletter_subscriptions.subscribed_at,excluded.subscribed_at),
        unsubscribed_at = null,confirmation_nonce = null,updated_at = now()
      where public.newsletter_subscriptions.status <> 'unsubscribed'
        and public.newsletter_subscriptions.email_enabled;
    exception when sqlstate 'P0001' then
      -- Contact allowance failures must never roll back a completed purchase.
      continue;
    end;
  end loop;
end;
$$;
revoke all on function public.commerce_subscribe_paid_order_buyer_for_order(public.commerce_orders)
  from public, anon, authenticated;

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
      and (contact.marketing_status = 'subscribed' or (
        campaign.kind = 'newsletter'
        and public.has_paid_newsletter_delivery_access(campaign.creator_id,campaign.publication_id,contact.id)
      ))
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
    and (contact.marketing_status = 'subscribed' or (
        campaign.kind = 'newsletter'
        and public.has_paid_newsletter_delivery_access(campaign.creator_id,campaign.publication_id,contact.id)
      ))
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
    and (contact.marketing_status = 'subscribed' or (
        campaign.kind = 'newsletter'
        and public.has_paid_newsletter_delivery_access(campaign.creator_id,campaign.publication_id,contact.id)
      ))
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
     and (contact_record.marketing_status = 'subscribed' or (
       campaign_record.kind = 'newsletter'
       and public.has_paid_newsletter_delivery_access(
         campaign_record.creator_id,campaign_record.publication_id,contact_record.id)
     ))
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
      and (contact.marketing_status = 'subscribed' or public.has_paid_newsletter_delivery_access(p_creator_id,p_publication_id,contact.id))
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

    subscribed_count := public.count_email_delivery_contacts(new.creator_id,new.contact_id);

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
revoke all on function public.commerce_apply_audience_consent() from public,anon,authenticated;
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

  subscribed_count := public.count_email_delivery_contacts(p_creator_id);

  return jsonb_build_object(
    'plan', creator_plan,
    'limit', contact_limit,
    'subscribed', subscribed_count,
    'remaining', greatest(contact_limit::bigint - subscribed_count, 0),
    'over_limit', subscribed_count > contact_limit
  );
end;
$function$;
revoke all on function public.email_marketing_capacity(uuid) from public,anon,authenticated;
grant execute on function public.email_marketing_capacity(uuid) to service_role;
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

  subscribed_count := public.count_email_delivery_contacts(v_creator_id);

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
revoke all on function public.prepare_audience_campaign_recipients_with_capacity(uuid) from public,anon,authenticated;
grant execute on function public.prepare_audience_campaign_recipients_with_capacity(uuid) to service_role;

notify pgrst, 'reload schema';
