create or replace function public.commerce_subscribe_paid_order_buyer_for_order(
  order_row public.commerce_orders
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  publication_record public.newsletter_publications%rowtype;
  contact public.audience_contacts%rowtype;
  subscription public.newsletter_subscriptions%rowtype;
  contact_row_id uuid;
  consent_key text := 'source:purchase_checkout:order:' || order_row.id::text;
  subscribed_at timestamptz := coalesce(
    order_row.paid_at,
    order_row.updated_at,
    order_row.created_at,
    now()
  );
begin
  if order_row.status <> 'paid'
    or order_row.creator_id is null
    or order_row.buyer_email is null
    or trim(order_row.buyer_email) = ''
  then
    return;
  end if;

  select publication.*
  into publication_record
  from public.newsletter_publications publication
  where publication.creator_id = order_row.creator_id
    and publication.status <> 'archived'
  order by publication.is_default desc, publication.created_at, publication.id
  limit 1
  for update;

  if publication_record.id is null then
    return;
  end if;

  contact_row_id := public.commerce_upsert_audience_contact(
    order_row.creator_id,
    order_row.buyer_email,
    order_row.buyer_name,
    'purchase_checkout',
    subscribed_at
  );

  select contact_row.*
  into contact
  from public.audience_contacts contact_row
  where contact_row.id = contact_row_id
    and contact_row.creator_id = order_row.creator_id
  for update;

  if contact.id is null or contact.marketing_status = 'unsubscribed' then
    return;
  end if;

  select subscription_row.*
  into subscription
  from public.newsletter_subscriptions subscription_row
  where subscription_row.publication_id = publication_record.id
    and subscription_row.contact_id = contact.id
  for update;

  if subscription.status = 'unsubscribed' then
    return;
  end if;

  begin
    insert into public.audience_consent_events(
      creator_id,
      contact_id,
      status,
      source,
      proof,
      occurred_at,
      idempotency_key
    ) values (
      order_row.creator_id,
      contact.id,
      'subscribed',
      'purchase_checkout',
      jsonb_build_object(
        'order_id', order_row.id,
        'product_id', order_row.product_id,
        'disclosure', 'purchase_newsletter_subscription'
      ),
      subscribed_at,
      consent_key
    ) on conflict (creator_id, idempotency_key)
      where idempotency_key is not null
      do nothing;

    insert into public.newsletter_subscriptions(
      publication_id,
      contact_id,
      status,
      email_enabled,
      source,
      consent_proof,
      subscribed_at,
      unsubscribed_at,
      confirmation_nonce
    ) values (
      publication_record.id,
      contact.id,
      'subscribed',
      true,
      'purchase_checkout',
      jsonb_build_object(
        'order_id', order_row.id,
        'product_id', order_row.product_id,
        'disclosure', 'purchase_newsletter_subscription'
      ),
      subscribed_at,
      null,
      null
    ) on conflict (publication_id, contact_id) do update
      set status = 'subscribed',
          email_enabled = true,
          source = 'purchase_checkout',
          consent_proof = public.newsletter_subscriptions.consent_proof || excluded.consent_proof,
          subscribed_at = coalesce(public.newsletter_subscriptions.subscribed_at, excluded.subscribed_at),
          unsubscribed_at = null,
          confirmation_nonce = null,
          updated_at = now()
      where public.newsletter_subscriptions.status <> 'unsubscribed';
  exception when sqlstate 'P0001' then
    -- Contact allowance failures must never roll back a completed purchase.
    return;
  end;

  return;
end;
$$;

revoke all on function public.commerce_subscribe_paid_order_buyer_for_order(
  public.commerce_orders
) from public, anon, authenticated;

create or replace function public.commerce_subscribe_paid_order_buyer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'paid' then
    return new;
  end if;

  perform public.commerce_subscribe_paid_order_buyer_for_order(new);
  return new;
end;
$$;

revoke all on function public.commerce_subscribe_paid_order_buyer()
  from public, anon, authenticated;

drop trigger if exists commerce_orders_subscribe_newsletter on public.commerce_orders;
create trigger commerce_orders_subscribe_newsletter
  after insert or update of status on public.commerce_orders
  for each row execute function public.commerce_subscribe_paid_order_buyer();

-- Re-run each creator/buyer pair through the same idempotent trigger. The
-- capacity trigger admits eligible contacts in purchase order and safely skips
-- the rest without changing the paid order.
do $$
declare
  paid_order public.commerce_orders%rowtype;
begin
  for paid_order in
    with backfill_ranked_buyers as (
      select
        orders.id,
        orders.creator_id,
        coalesce(orders.paid_at, orders.updated_at, orders.created_at) as purchased_at,
        row_number() over (
          partition by orders.creator_id, lower(trim(orders.buyer_email))
          order by coalesce(orders.paid_at, orders.updated_at, orders.created_at), orders.id
        ) as buyer_rank
      from public.commerce_orders orders
      where orders.status = 'paid'
        and orders.buyer_email is not null
        and trim(orders.buyer_email) <> ''
    )
    select orders.*
    from backfill_ranked_buyers ranked
    join public.commerce_orders orders on orders.id = ranked.id
    where ranked.buyer_rank = 1
    order by ranked.creator_id, ranked.purchased_at, ranked.id
  loop
    perform public.commerce_subscribe_paid_order_buyer_for_order(paid_order);
  end loop;
end;
$$;
