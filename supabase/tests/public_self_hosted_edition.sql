-- Run after the public migrations against an isolated local database.
-- Every synthetic fixture and queued welcome message is rolled back.
begin;
do $$
declare
  creator uuid := gen_random_uuid();
  publication uuid;
  product uuid;
begin
  if not exists (select 1 from public.bento_instance_settings where singleton and edition='self_hosted') then
    raise exception 'Public installation must initialize the self-hosted database edition';
  end if;
  insert into auth.users(id,email) values(creator,'public-edition-'||creator||'@example.test');
  -- Auth bootstrap retains the normal free profile; edition configuration alone
  -- must provide self-hosted entitlements, without fake billing state.
  if exists(select 1 from public.subscriptions where user_id=creator)
    or exists(select 1 from public.complimentary_plan_grants where user_id=creator)
    or exists(select 1 from public.profiles where id=creator and plan_id in ('creator','creator_plus')) then
    raise exception 'Fixture unexpectedly depends on a hosted plan or complimentary grant';
  end if;
  if public.bento_effective_billing_plan(creator) <> 'creator_plus'
    or not public.bento_has_creator_access(creator)
    or public.email_marketing_contact_limit_snapshot(creator) <> 2147483647 then
    raise exception 'Self-hosted application and database entitlements disagree';
  end if;
  insert into public.newsletter_publications(creator_id,title,slug,sender_name,postal_address,status,is_default)
    values(creator,'Public edition newsletter','public-edition-'||creator,'Creator','Test address','published',true)
    returning id into publication;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,
    price_amount,currency,billing_interval,settings)
    values(creator,'newsletter','published','public-edition-'||creator,'public-edition-'||creator,
      'Public edition newsletter','subscription',1000,'inr','month',
      jsonb_build_object('newsletterPublicationId',publication)) returning id into product;
  update public.newsletter_publications set paid_product_id=product where id=publication;
  if not public.can_accept_paid_newsletter_checkout(product,'buyer@example.test') then
    raise exception 'Fresh self-hosted paid newsletter checkout is unavailable';
  end if;
  if has_table_privilege('anon','public.bento_instance_settings','UPDATE')
    or has_table_privilege('authenticated','public.bento_instance_settings','UPDATE') then
    raise exception 'Public clients must not control instance entitlements';
  end if;
end $$;
rollback;
