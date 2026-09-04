alter table public.newsletter_subscriptions
  add column if not exists confirmation_nonce uuid;

update public.newsletter_subscriptions
set confirmation_nonce = gen_random_uuid()
where status = 'pending' and confirmation_nonce is null;

create or replace function public.capture_public_newsletter_subscription(
  p_block_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  block_row public.blocks%rowtype;
  publication_row public.newsletter_publications%rowtype;
  contact_row public.audience_contacts%rowtype;
  subscription_row public.newsletter_subscriptions%rowtype;
  publication_id uuid;
  creator_username text;
  creator_display_name text;
  normalized_email text := lower(trim(p_email));
begin
  if normalized_email = '' or length(normalized_email) > 254 then
    raise exception 'A valid email is required';
  end if;
  select * into block_row
  from public.blocks
  where id = p_block_id
  for update;
  if block_row.id is null or block_row.type <> 'email_capture' then
    raise exception 'Email capture block not found';
  end if;

  begin
    publication_id := (block_row.content ->> 'newsletterPublicationId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Newsletter publication link is invalid';
  end;
  if publication_id is null then
    raise exception 'Newsletter publication link is required';
  end if;

  select * into publication_row
  from public.newsletter_publications
  where id = publication_id
  for update;
  if publication_row.id is null
    or publication_row.status <> 'published'
    or publication_row.creator_id <> block_row.user_id
  then
    raise exception 'Newsletter publication is not available';
  end if;

  select username, display_name
  into creator_username, creator_display_name
  from public.profiles
  where id = publication_row.creator_id;
  if creator_username is null then
    raise exception 'Newsletter creator profile is not available';
  end if;

  select * into contact_row
  from public.audience_contacts
  where id = public.commerce_upsert_audience_contact(
    publication_row.creator_id,
    normalized_email,
    null,
    'newsletter_signup',
    now()
  )
  for update;
  if contact_row.id is null or contact_row.creator_id <> publication_row.creator_id then
    raise exception 'Newsletter contact ownership is invalid';
  end if;

  insert into public.audience_events(
    creator_id, contact_id, event_type, source_type, source_id, dedupe_key, metadata
  ) values (
    publication_row.creator_id,
    contact_row.id,
    'newsletter_signup_requested',
    'email_capture_block',
    block_row.id,
    'newsletter-signup:' || publication_row.id || ':' || contact_row.id,
    jsonb_build_object('block_id', block_row.id, 'publication_id', publication_row.id)
  ) on conflict (creator_id, dedupe_key) do nothing;

  select * into subscription_row
  from public.newsletter_subscriptions
  where publication_id = publication_row.id and contact_id = contact_row.id
  for update;

  if subscription_row.id is null then
    insert into public.newsletter_subscriptions(
      publication_id, contact_id, status, email_enabled, source,
      confirmation_nonce, consent_proof
    ) values (
      publication_row.id,
      contact_row.id,
      'pending',
      true,
      'newsletter_signup',
      gen_random_uuid(),
      jsonb_build_object('block_id', block_row.id, 'requested_at', now())
    ) returning * into subscription_row;
  elsif subscription_row.status = 'unsubscribed' then
    update public.newsletter_subscriptions
    set status = 'pending',
        email_enabled = true,
        source = 'newsletter_signup',
        confirmation_nonce = gen_random_uuid(),
        consent_proof = jsonb_build_object('block_id', block_row.id, 'requested_at', now()),
        subscribed_at = null,
        unsubscribed_at = null
    where id = subscription_row.id
    returning * into subscription_row;
  elsif subscription_row.status = 'pending' and subscription_row.confirmation_nonce is null then
    update public.newsletter_subscriptions
    set confirmation_nonce = gen_random_uuid()
    where id = subscription_row.id
    returning * into subscription_row;
  elsif subscription_row.status = 'subscribed' then
    return jsonb_build_object(
      'confirmation_required', false
    );
  end if;

  insert into public.email_outbox(
    event_key, event_type, category, recipient_email, user_id, payload
  ) values (
    'newsletter-confirmation:' || subscription_row.id || ':' || subscription_row.confirmation_nonce,
    'newsletter_subscription_confirmation',
    'transactional',
    normalized_email,
    publication_row.creator_id,
    jsonb_build_object(
      'publicationId', publication_row.id,
      'subscriptionId', subscription_row.id,
      'confirmationNonce', subscription_row.confirmation_nonce,
      'email', normalized_email,
      'publicationTitle', publication_row.title,
      'creatorUsername', creator_username,
      'creatorDisplayName', coalesce(nullif(trim(creator_display_name), ''), creator_username)
    )
  ) on conflict (event_key) do nothing;

  return jsonb_build_object(
    'confirmation_required', true
  );
end;
$$;

create or replace function public.confirm_public_newsletter_subscription(
  p_publication_id uuid,
  p_subscription_id uuid,
  p_confirmation_nonce uuid,
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  publication_row public.newsletter_publications%rowtype;
  contact_row public.audience_contacts%rowtype;
  subscription_row public.newsletter_subscriptions%rowtype;
  normalized_email text := lower(trim(p_email));
begin
  if normalized_email = '' or length(normalized_email) > 254 then
    return false;
  end if;

  select * into publication_row
  from public.newsletter_publications
  where id = p_publication_id
  for update;
  if publication_row.id is null
    or publication_row.status <> 'published'
  then
    return false;
  end if;

  select * into subscription_row
  from public.newsletter_subscriptions
  where id = p_subscription_id
    and publication_id = publication_row.id
    and confirmation_nonce = p_confirmation_nonce
  for update;
  if subscription_row.id is null or subscription_row.status <> 'pending' then
    return false;
  end if;

  select * into contact_row
  from public.audience_contacts
  where id = subscription_row.contact_id
    and creator_id = publication_row.creator_id
    and email_normalized = normalized_email
  for update;
  if contact_row.id is null or contact_row.creator_id <> publication_row.creator_id then
    return false;
  end if;

  update public.newsletter_subscriptions
  set status = 'subscribed',
      email_enabled = true,
      subscribed_at = now(),
      unsubscribed_at = null,
      confirmation_nonce = null,
      consent_proof = consent_proof || jsonb_build_object(
        'confirmed_at', now(),
        'confirmation', 'signed_link'
      )
  where id = subscription_row.id;

  insert into public.audience_consent_events(
    creator_id, contact_id, status, source, proof
  ) values (
    publication_row.creator_id,
    contact_row.id,
    'subscribed',
    'newsletter_confirmation',
    jsonb_build_object(
      'publication_id', publication_row.id,
      'subscription_id', subscription_row.id,
      'confirmation_nonce', p_confirmation_nonce,
      'disclosure', 'newsletter_subscription'
    )
  );

  return true;
end;
$$;

revoke all on function public.capture_public_newsletter_subscription(uuid, text)
  from public, anon, authenticated;
revoke all on function public.confirm_public_newsletter_subscription(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.capture_public_newsletter_subscription(uuid, text)
  to service_role;
grant execute on function public.confirm_public_newsletter_subscription(uuid, uuid, uuid, text)
  to service_role;
