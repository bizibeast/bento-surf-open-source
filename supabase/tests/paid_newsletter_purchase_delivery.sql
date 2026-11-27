-- Execute against an isolated local database with current migrations. No email is sent.
begin;

create function pg_temp.assert_publication_delivery(
  p_creator uuid, p_contact uuid, p_publication uuid, p_paid boolean, p_expected boolean
) returns void language plpgsql as $$
declare campaign uuid; outbox uuid; eligible boolean; authorized boolean;
begin
  insert into public.audience_campaigns(creator_id,name,subject,body_markdown,status,
    delivery_status,kind,publication_id,public_slug,web_visibility)
  values(p_creator,'Delivery contract','Delivery contract','Fixture body','sending','sending',
    case when p_publication is null then 'broadcast' else 'newsletter' end,p_publication,
    case when p_paid then 'issue-'||gen_random_uuid()::text else null end,
    case when p_paid then 'paid' else 'private' end) returning id into campaign;
  select exists(select 1 from public.prepare_audience_campaign_recipients(campaign) r
    where r.contact_id=p_contact) into eligible;
  if eligible is distinct from p_expected then
    raise exception 'Recipient preparation mismatch: publication %, expected %, got %',p_publication,p_expected,eligible;
  end if;
  insert into public.email_outbox(event_key,event_type,category,recipient_email,user_id)
  select 'audience-campaign:'||campaign::text||':'||p_contact::text,
    'audience_campaign','marketing',email,p_creator from public.audience_contacts where id=p_contact
  returning id into outbox;
  -- Force an outbox candidate even when prepare rejected it; send authorization
  -- must independently enforce the identical consent and entitlement boundary.
  insert into public.audience_campaign_recipients(campaign_id,contact_id,email_outbox_id,status)
  values(campaign,p_contact,outbox,'queued') on conflict on constraint audience_campaign_recipients_unique
  do update set email_outbox_id=excluded.email_outbox_id,status='queued';
  authorized:=public.authorize_audience_campaign_delivery(outbox);
  if authorized is distinct from p_expected then
    raise exception 'Send authorization mismatch: publication %, expected %, got %',p_publication,p_expected,authorized;
  end if;
end;
$$;

create function pg_temp.paid_newsletter_order(
  p_product uuid,p_creator uuid,p_provider text,p_email text,p_opt_in boolean default false,
  p_status public.commerce_order_status default 'paid',p_amount integer default 1000
) returns uuid language plpgsql as $$
declare order_id uuid;
begin
  insert into public.commerce_orders(product_id,creator_id,buyer_email,buyer_name,status,provider,
    provider_account_id,provider_checkout_id,provider_payment_id,provider_subscription_id,
    gross_amount,net_amount,currency,metadata,paid_at)
  values(p_product,p_creator,p_email,'Newsletter buyer',p_status,p_provider,p_provider||'-account',
    gen_random_uuid()::text,gen_random_uuid()::text,p_provider||'-subscription-'||p_email,
    p_amount,p_amount,'usd',jsonb_build_object('newsletter_opt_in',p_opt_in,
      'newsletterPublicationId','00000000-0000-4000-8000-000000000001'),now()) returning id into order_id;
  if p_status='paid' and p_amount>0 then
    insert into public.commerce_access_grants(order_id,product_id,creator_id,buyer_email,token_hash)
    values(order_id,p_product,p_creator,p_email,encode(extensions.digest(order_id::text,'sha256'),'hex'));
  end if;
  return order_id;
end;
$$;

do $$
#variable_conflict use_variable
declare
  creator uuid:=gen_random_uuid(); other_creator uuid:=gen_random_uuid();
  publication_a uuid; publication_b uuid; publication_other uuid; product_b uuid; ordinary_product uuid;
  provider_name text; buyer text; order_id uuid; contact_id uuid; grant_id uuid; first_subscription uuid;
  renewal_order uuid; subscription_access_id uuid; next_order uuid; session_id uuid; account_id uuid;
  publication_count bigint; payment_id text; lifecycle_result jsonb; period_base timestamptz:=now();
  invalid_link text; order_status public.commerce_order_status; fabricated public.commerce_orders%rowtype;
begin
  insert into auth.users(id,email) values(creator,'newsletter-owner-'||creator||'@example.test'),
    (other_creator,'newsletter-other-'||other_creator||'@example.test');
  update public.profiles set plan_id='creator' where id in(creator,other_creator);
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(creator,'Free A','free-a','Creator','Test address','published',true) returning id into publication_a;
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(creator,'Paid B','paid-b','Creator','Test address','published',false) returning id into publication_b;
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(other_creator,'Other publication','other','Other','Test address','published',true) returning id into publication_other;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,
    price_amount,currency,billing_interval,settings)
    values(creator,'newsletter','published','paid-newsletter-'||gen_random_uuid(),
      'paid-newsletter-'||gen_random_uuid(),'Paid B','subscription',1000,'usd','month',
      jsonb_build_object('newsletterPublicationId',publication_b)) returning id into product_b;
  update public.newsletter_publications set paid_product_id=product_b where id=publication_b;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency)
    values(creator,'digital_product','published','ordinary-'||gen_random_uuid(),'ordinary-'||gen_random_uuid(),
      'Ordinary download','one_time',1000,'usd') returning id into ordinary_product;

  foreach provider_name in array array['stripe','paypal','razorpay','dodo','creem','polar'] loop
    buyer:=provider_name||'-delivery@example.test';
    order_id:=pg_temp.paid_newsletter_order(product_b,creator,provider_name,buyer);
    select id into strict contact_id from public.audience_contacts
      where creator_id=creator and email_normalized=buyer;
    select id into first_subscription from public.newsletter_subscriptions
      where publication_id=publication_b and newsletter_subscriptions.contact_id=contact_id
        and status='subscribed' and email_enabled;
    if first_subscription is null then
      raise exception 'Paid % purchase must subscribe to nondefault purchased publication B',provider_name;
    end if;
    if exists(select 1 from public.newsletter_subscriptions where publication_id=publication_a
      and newsletter_subscriptions.contact_id=contact_id) then
      raise exception 'Paid B purchase silently subscribed buyer to unrelated default A';
    end if;
    if exists(select 1 from public.audience_contacts where id=contact_id
      and(marketing_status<>'unknown' or marketing_consent))
      or exists(select 1 from public.audience_consent_events where audience_consent_events.contact_id=contact_id) then
      raise exception 'Paid delivery must not manufacture global marketing consent';
    end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);
    select recipient_count into publication_count from public.get_newsletter_publication_recipient_counts(creator,publication_b)
      where list_id is null;
    if publication_count<>1 then raise exception 'Publication recipient readout excluded paid-only delivery'; end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_a,false,false);
    perform pg_temp.assert_publication_delivery(creator,contact_id,null,false,false);

    -- Existing per-publication pause and unsubscribe preferences survive renewals.
    update public.newsletter_subscriptions set email_enabled=false where id=first_subscription;
    perform pg_temp.paid_newsletter_order(product_b,creator,provider_name,buyer);
    if (select email_enabled from public.newsletter_subscriptions where id=first_subscription) then
      raise exception 'Renewal re-enabled paused publication delivery';
    end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
    update public.newsletter_subscriptions set status='unsubscribed',unsubscribed_at=now()
      where id=first_subscription;
    perform pg_temp.paid_newsletter_order(product_b,creator,provider_name,buyer,true);
    if (select status from public.newsletter_subscriptions where id=first_subscription)<>'unsubscribed' then
      raise exception 'Renewal revived an explicit publication unsubscribe';
    end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);

    -- A prior global unsubscribe overrides a later paid purchase and opt-in bit.
    buyer:=provider_name||'-global-unsub@example.test';
    contact_id:=public.commerce_upsert_audience_contact(creator,buyer,'Buyer','fixture',now());
    insert into public.audience_consent_events(creator_id,contact_id,status,source)
      values(creator,contact_id,'unsubscribed','buyer_preferences');
    perform pg_temp.paid_newsletter_order(product_b,creator,provider_name,buyer,true);
    if exists(select 1 from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id)
      or (select marketing_status from public.audience_contacts where id=contact_id)<>'unsubscribed' then
      raise exception 'Purchase overrode global unsubscribe';
    end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
  end loop;

  -- An A-only unsubscribe is not B delivery consent and cannot be overwritten.
  buyer:='unsubscribed-a@example.test';
  contact_id:=public.commerce_upsert_audience_contact(creator,buyer,'Buyer','fixture',now());
  insert into public.newsletter_subscriptions(publication_id,contact_id,status,email_enabled,source,unsubscribed_at)
    values(publication_a,contact_id,'unsubscribed',false,'buyer_preferences',now());
  perform pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer,true);
  if (select status from public.newsletter_subscriptions where publication_id=publication_a
    and newsletter_subscriptions.contact_id=contact_id)<>'unsubscribed'
    or(select marketing_status from public.audience_contacts where id=contact_id)<>'unknown' then
    raise exception 'A publication unsubscribe was overwritten by another publication purchase'; end if;
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_a,false,false);
  perform pg_temp.assert_publication_delivery(creator,contact_id,null,false,false);

  -- Optional creator updates remain a separate, explicit enrollment in default A.
  buyer:='paid-and-updates@example.test';
  perform pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer,true);
  select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
  if (select count(*) from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id
    and publication_id in(publication_a,publication_b) and status='subscribed')<>2 then
    raise exception 'Explicit creator-update consent must be separate from paid B delivery';
  end if;
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_a,false,true);
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);
  perform pg_temp.assert_publication_delivery(creator,contact_id,null,false,true);

  -- Ordinary purchases retain their original optional marketing behavior.
  foreach buyer in array array['ordinary-no@example.test','ordinary-yes@example.test'] loop
    perform pg_temp.paid_newsletter_order(ordinary_product,creator,'stripe',buyer,buyer='ordinary-yes@example.test');
    select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_a,false,buyer='ordinary-yes@example.test');
    if exists(select 1 from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id
      and publication_id=publication_b) then raise exception 'Ordinary product enrolled paid B'; end if;
  end loop;

  -- Scoped delivery cannot survive expired/revoked grants or refunded payment history.
  foreach buyer in array array['expired@example.test','revoked@example.test','refunded@example.test'] loop
    order_id:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
    select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
    if buyer='expired@example.test' then update public.commerce_access_grants set expires_at=now()-interval'1 minute' where commerce_access_grants.order_id=order_id;
    elsif buyer='revoked@example.test' then update public.commerce_access_grants set status='revoked' where commerce_access_grants.order_id=order_id;
    else update public.commerce_orders set status='refunded',refunded_amount=gross_amount where id=order_id; end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
  end loop;

  buyer:='partial-refund@example.test';
  order_id:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
  update public.commerce_orders set status='partially_refunded',refunded_amount=100 where id=order_id;
  select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);

  -- Failed/pending/trial payments cannot gain delivery through a fabricated subscription/grant.
  foreach order_status in array array['pending','failed']::public.commerce_order_status[] loop
    buyer:=order_status::text||'@example.test';
    order_id:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer,false,order_status);
    select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
    if exists(select 1 from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id) then
      raise exception 'Unpaid order created a newsletter subscription'; end if;
    insert into public.commerce_access_grants(order_id,product_id,creator_id,buyer_email,token_hash)
      values(order_id,product_b,creator,buyer,encode(extensions.digest(order_id::text,'sha256'),'hex'));
    insert into public.newsletter_subscriptions(publication_id,contact_id,status,email_enabled,source,consent_proof)
      values(publication_b,contact_id,'subscribed',true,'paid_newsletter_purchase',
        jsonb_build_object('purpose','paid_newsletter_delivery','publication_id',publication_b,'product_id',product_b));
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
  end loop;
  buyer:='zero-trial@example.test';
  perform pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer,false,'paid',0);
  select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
  if exists(select 1 from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id) then
    raise exception 'Zero-amount trial manufactured a paid subscription'; end if;

  -- Passing a forged composite cannot create subscribers or opt in a real order.
  fabricated.id:=gen_random_uuid();fabricated.product_id:=product_b;fabricated.creator_id:=creator;
  fabricated.buyer_email:='fabricated@example.test';fabricated.status:='paid';fabricated.gross_amount:=1000;
  fabricated.provider:='stripe';fabricated.metadata:='{"newsletter_opt_in":true}';
  perform public.commerce_subscribe_paid_order_buyer_for_order(fabricated);
  if exists(select 1 from public.audience_contacts where creator_id=creator
    and email_normalized='fabricated@example.test') then raise exception 'Fabricated order created a contact'; end if;
  order_id:=pg_temp.paid_newsletter_order(ordinary_product,creator,'stripe','forged-optin@example.test',false);
  select * into fabricated from public.commerce_orders where id=order_id;
  fabricated.metadata:='{"newsletter_opt_in":true}';
  perform public.commerce_subscribe_paid_order_buyer_for_order(fabricated);
  select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized='forged-optin@example.test';
  if exists(select 1 from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id) then
    raise exception 'Forged composite metadata manufactured marketing consent'; end if;

  -- Drive the real verified-funding and refund/dispute RPCs while retaining
  -- the original durable grant. Historical refunds must not erase a newer paid period.
  buyer:='current-funding@example.test';
  insert into public.creator_payment_accounts(creator_id,provider,provider_account_id)
    values(creator,'stripe','stripe-account') returning id into account_id;
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,
    provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,status)
    values(product_b,creator,account_id,'stripe','stripe-subscription-'||buyer,buyer,1000,0,0,'usd','paid')
    returning id into session_id;
  order_id:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
  update public.commerce_orders set metadata=metadata||jsonb_build_object('bento_session_id',session_id) where id=order_id;
  select id into grant_id from public.commerce_access_grants where commerce_access_grants.order_id=order_id;
  select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
  lifecycle_result:=public.apply_commerce_subscription_lifecycle_funded('stripe','stripe-account','stripe-subscription-'||buyer,
    'renewed','newsletter-funding-1',period_base,period_base+interval'1 month',false,'{}',3,order_id);
  if not(lifecycle_result->>'applied')::boolean then raise exception 'Initial paid newsletter funding did not apply: %',lifecycle_result; end if;
  -- Existing ten-argument status callers keep their original RPC contract.
  lifecycle_result:=public.apply_commerce_subscription_lifecycle_guarded('stripe','stripe-account','stripe-subscription-'||buyer,
    'active','newsletter-legacy-status',period_base,period_base+interval'1 month',false,'{}',3);
  if not(lifecycle_result->>'applied')::boolean then raise exception 'Legacy lifecycle status wrapper failed: %',lifecycle_result; end if;
  renewal_order:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
  update public.commerce_orders set metadata=metadata||jsonb_build_object('bento_session_id',session_id) where id=renewal_order;
  delete from public.commerce_access_grants where commerce_access_grants.order_id=renewal_order;
  lifecycle_result:=public.apply_commerce_subscription_lifecycle_funded('stripe','stripe-account','stripe-subscription-'||buyer,
    'renewed','newsletter-funding-2',period_base+interval'1 month',period_base+interval'2 months',false,'{}',3,renewal_order);
  if not(lifecycle_result->>'applied')::boolean then raise exception 'Renewed newsletter funding did not apply: %',lifecycle_result; end if;
  select provider_payment_id into payment_id from public.commerce_orders where id=order_id;
  perform public.apply_commerce_refund('stripe',payment_id,'stripe-account','newsletter-refund-old',1000,true,'{}',now());
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);
  select provider_payment_id into payment_id from public.commerce_orders where id=renewal_order;
  perform public.apply_commerce_refund('stripe',payment_id,'stripe-account','newsletter-refund-current',1000,true,'{}',now());
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
  next_order:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
  update public.commerce_orders set metadata=metadata||jsonb_build_object('bento_session_id',session_id) where id=next_order;
  delete from public.commerce_access_grants where commerce_access_grants.order_id=next_order;
  lifecycle_result:=public.apply_commerce_subscription_lifecycle_funded('stripe','stripe-account','stripe-subscription-'||buyer,
    'renewed','newsletter-funding-3',period_base+interval'2 months',period_base+interval'3 months',false,'{}',3,next_order);
  if not(lifecycle_result->>'applied')::boolean then raise exception 'Newer paid period did not recover newsletter delivery: %',lifecycle_result; end if;
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);
  select provider_payment_id into payment_id from public.commerce_orders where id=next_order;
  perform public.apply_commerce_dispute_guarded('stripe',payment_id,'stripe-account','newsletter-dispute-current',
    'newsletter-dispute-id','open',1000,null,'{}',now());
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
  next_order:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
  update public.commerce_orders set metadata=metadata||jsonb_build_object('bento_session_id',session_id) where id=next_order;
  delete from public.commerce_access_grants where commerce_access_grants.order_id=next_order;
  lifecycle_result:=public.apply_commerce_subscription_lifecycle_funded('stripe','stripe-account','stripe-subscription-'||buyer,
    'renewed','newsletter-funding-4',period_base+interval'3 months',period_base+interval'4 months',false,'{}',3,next_order);
  if not(lifecycle_result->>'applied')::boolean then raise exception 'Paid recovery after dispute did not apply: %',lifecycle_result; end if;
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,true);
  if(select count(*) from public.commerce_access_grants where product_id=product_b and buyer_email=buyer)<>1
    or not exists(select 1 from public.commerce_access_grants where id=grant_id and commerce_access_grants.order_id=order_id) then
    raise exception 'Newsletter recovery replaced the original durable grant'; end if;
  update public.newsletter_subscriptions set status='unsubscribed',email_enabled=false,unsubscribed_at=now()
    where publication_id=publication_b and newsletter_subscriptions.contact_id=contact_id;
  next_order:=pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
  update public.commerce_orders set metadata=metadata||jsonb_build_object('bento_session_id',session_id) where id=next_order;
  delete from public.commerce_access_grants where commerce_access_grants.order_id=next_order;
  perform public.apply_commerce_subscription_lifecycle_funded('stripe','stripe-account','stripe-subscription-'||buyer,
    'renewed','newsletter-funding-5',period_base+interval'4 months',period_base+interval'5 months',false,'{}',3,next_order);
  perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);

  -- Mutable/malformed/foreign publication references must not fall back to A.
  foreach invalid_link in array array[publication_a::text,publication_other::text,gen_random_uuid()::text,'bad-reference',''] loop
    update public.commerce_products set settings=jsonb_build_object('newsletterPublicationId',invalid_link) where id=product_b;
    buyer:=gen_random_uuid()::text||'@example.test';
    perform pg_temp.paid_newsletter_order(product_b,creator,'stripe',buyer);
    select id into contact_id from public.audience_contacts where creator_id=creator and email_normalized=buyer;
    if exists(select 1 from public.newsletter_subscriptions where newsletter_subscriptions.contact_id=contact_id) then
      raise exception 'Invalid publication relationship created delivery/marketing subscription'; end if;
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_a,false,false);
    perform pg_temp.assert_publication_delivery(creator,contact_id,publication_b,true,false);
  end loop;
end;
$$;


-- A deliberately small allowance exists only inside this rolled-back, isolated
-- database test. It exercises the production guards without 500-row fixtures.
select set_config('bento.test_contact_limit','2',true);
create or replace function public.email_marketing_contact_limit_snapshot(p_creator_id uuid)
returns integer language sql stable security definer set search_path='' as $$
  select current_setting('bento.test_contact_limit')::integer;
$$;

do $$
#variable_conflict use_variable
declare creator uuid:=gen_random_uuid(); pub_a uuid; pub_b uuid; pub_c uuid;
  product_b uuid; product_c uuid; ordinary_product uuid; first_contact uuid; blocked_contact uuid;
  order_id uuid; recipient_count bigint; capacity jsonb; campaign uuid;
begin
  insert into auth.users(id,email) values(creator,'capacity-'||creator||'@example.test');
  update public.profiles set plan_id='creator' where id=creator;
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(creator,'A','a','Creator','Test address','published',true) returning id into pub_a;
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(creator,'B','b','Creator','Test address','published',false) returning id into pub_b;
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(creator,'C','c','Creator','Test address','published',false) returning id into pub_c;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,
    price_amount,currency,billing_interval,settings) values(creator,'newsletter','published',
    'capacity-b-'||gen_random_uuid(),'capacity-b-'||gen_random_uuid(),'B','subscription',1000,'usd','month',
    jsonb_build_object('newsletterPublicationId',pub_b)) returning id into product_b;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,
    price_amount,currency,billing_interval,settings) values(creator,'newsletter','published',
    'capacity-c-'||gen_random_uuid(),'capacity-c-'||gen_random_uuid(),'C','subscription',1000,'usd','month',
    jsonb_build_object('newsletterPublicationId',pub_c)) returning id into product_c;
  update public.newsletter_publications set paid_product_id=product_b where id=pub_b;
  update public.newsletter_publications set paid_product_id=product_c where id=pub_c;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency)
    values(creator,'digital_product','published','capacity-download-'||gen_random_uuid(),
      'capacity-download-'||gen_random_uuid(),'Download','one_time',1000,'usd') returning id into ordinary_product;

  if not public.can_accept_paid_newsletter_checkout(product_b,'first-capacity@example.test')
    or public.can_accept_paid_newsletter_checkout(ordinary_product,'first-capacity@example.test')
    or public.can_accept_paid_newsletter_checkout(gen_random_uuid(),'first-capacity@example.test')
    or public.can_accept_paid_newsletter_checkout(product_b,'invalid-email') then
    raise exception 'Read-only checkout preflight rejected capacity or accepted an invalid offer/email'; end if;
  perform pg_temp.paid_newsletter_order(product_b,creator,'stripe','first-capacity@example.test');
  perform pg_temp.paid_newsletter_order(product_c,creator,'paypal','first-capacity@example.test');
  if public.count_email_delivery_contacts(creator)<>1 then
    raise exception 'Same buyer in two paid publications consumed duplicate contact allowance'; end if;
  perform pg_temp.paid_newsletter_order(product_b,creator,'stripe','second-capacity@example.test');
  perform pg_temp.paid_newsletter_order(ordinary_product,creator,'stripe','first-capacity@example.test',true);
  if public.count_email_delivery_contacts(creator)<>2 then
    raise exception 'Marketing plus paid publication membership double-counted a buyer'; end if;
  capacity:=public.email_marketing_capacity(creator);
  if(capacity->>'subscribed')::integer<>2 or(capacity->>'remaining')::integer<>0
    or(capacity->>'over_limit')::boolean then raise exception 'Capacity readout ignored scoped paid buyers: %',capacity; end if;
  select counts.recipient_count into recipient_count from public.get_newsletter_publication_recipient_counts(creator,pub_b) counts
    where list_id is null;
  if recipient_count<>2 then raise exception 'Paid publication count differs from deliverable membership'; end if;

  if public.can_accept_paid_newsletter_checkout(product_b,'blocked-capacity@example.test')
    or not public.can_accept_paid_newsletter_checkout(product_b,'first-capacity@example.test')
    or not public.can_accept_paid_newsletter_checkout(product_b,'second-capacity@example.test') then
    raise exception 'Preflight did not distinguish an already-counted buyer from a new full-capacity buyer'; end if;
  select id into first_contact from public.audience_contacts where creator_id=creator and email_normalized='first-capacity@example.test';
  update public.newsletter_subscriptions set email_enabled=false where publication_id=pub_b and contact_id=first_contact;
  if public.can_accept_paid_newsletter_checkout(product_b,'first-capacity@example.test') then
    raise exception 'Preflight accepted a paused publication preference'; end if;
  update public.newsletter_subscriptions set email_enabled=true where publication_id=pub_b and contact_id=first_contact;
  update public.newsletter_subscriptions set status='unsubscribed' where publication_id=pub_b and contact_id=first_contact;
  if public.can_accept_paid_newsletter_checkout(product_b,'first-capacity@example.test') then
    raise exception 'Preflight accepted an explicit publication unsubscribe'; end if;
  update public.newsletter_subscriptions set status='subscribed' where publication_id=pub_b and contact_id=first_contact;
  update public.audience_contacts set marketing_status='unsubscribed' where id=first_contact;
  if public.can_accept_paid_newsletter_checkout(product_b,'first-capacity@example.test') then
    raise exception 'Preflight accepted an explicit global unsubscribe'; end if;
  update public.audience_contacts set marketing_status='subscribed' where id=first_contact;
  order_id:=pg_temp.paid_newsletter_order(product_b,creator,'stripe','blocked-capacity@example.test');
  select id into blocked_contact from public.audience_contacts where creator_id=creator and email_normalized='blocked-capacity@example.test';
  if exists(select 1 from public.newsletter_subscriptions where contact_id=blocked_contact)
    or not exists(select 1 from public.commerce_orders where id=order_id and status='paid')
    or not exists(select 1 from public.commerce_access_grants where commerce_access_grants.order_id=order_id and status='active') then
    raise exception 'Email quota bypassed, or its failure rolled back paid web access'; end if;
  begin
    insert into public.newsletter_subscriptions(publication_id,contact_id,status,email_enabled,source,consent_proof)
      values(pub_b,blocked_contact,'subscribed',true,'paid_newsletter_purchase',
        jsonb_build_object('purpose','paid_newsletter_delivery','publication_id',pub_b,'product_id',product_b));
    raise exception 'Expected paid newsletter contact allowance rejection';
  exception when sqlstate 'P0001' then
    if position('contact allowance reached' in sqlerrm)=0 then raise; end if;
  end;
  order_id:=pg_temp.paid_newsletter_order(ordinary_product,creator,'stripe','blocked-marketing@example.test',true);
  if exists(select 1 from public.audience_contacts where creator_id=creator and email_normalized='blocked-marketing@example.test'
    and marketing_status='subscribed') or not exists(select 1 from public.commerce_orders where id=order_id and status='paid') then
    raise exception 'Generic consent ignored paid-only contacts or rolled back payment'; end if;

  -- A lower allowance must pause the actual sender wrapper as well as its UI readout.
  perform set_config('bento.test_contact_limit','1',true);
  capacity:=public.email_marketing_capacity(creator);
  if not(capacity->>'over_limit')::boolean then raise exception 'Reduced allowance not reflected by readout'; end if;
  insert into public.audience_campaigns(creator_id,name,subject,body_markdown,status,delivery_status,
    kind,publication_id,public_slug,web_visibility) values(creator,'Capacity','Capacity','Body','sending','sending',
    'newsletter',pub_b,'capacity-'||gen_random_uuid(),'paid') returning id into campaign;
  begin
    perform public.prepare_audience_campaign_recipients_with_capacity(campaign);
    raise exception 'Expected sender contact allowance rejection';
  exception when sqlstate 'P0001' then
    if position('contact allowance reached' in sqlerrm)=0 then raise; end if;
  end;
end;
$$;

do $$
begin
  if has_function_privilege('anon','public.has_paid_newsletter_delivery_access(uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.has_paid_newsletter_delivery_access(uuid,uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.has_paid_newsletter_delivery_access(uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.count_email_delivery_contacts(uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.guard_paid_newsletter_delivery_capacity()','EXECUTE')
    or has_function_privilege('anon','public.can_accept_paid_newsletter_checkout(uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.can_accept_paid_newsletter_checkout(uuid,text)','EXECUTE')
    or not has_function_privilege('service_role','public.can_accept_paid_newsletter_checkout(uuid,text)','EXECUTE')
    or has_function_privilege('anon','public.apply_commerce_subscription_lifecycle_funded(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,jsonb,integer,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.apply_commerce_subscription_lifecycle_funded(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,jsonb,integer,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.apply_commerce_subscription_lifecycle_funded(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,jsonb,integer,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.apply_commerce_subscription_lifecycle_guarded(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,jsonb,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.apply_commerce_subscription_lifecycle_guarded(text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,jsonb,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.commerce_subscribe_paid_order_buyer_for_order(public.commerce_orders)','EXECUTE') then
    raise exception 'Paid delivery consent/eligibility RPC permissions are not service-only';
  end if;
end;
$$;
rollback;
