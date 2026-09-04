-- Queue booking review access and its email as one transaction.
--
-- Previously the scheduler inserted the private review token and marked the
-- booking completed before the email outbox row was guaranteed to exist. A
-- transient database failure could therefore suppress the review email
-- permanently. This RPC makes the booking, review token, and outbox event one
-- atomic lifecycle transition.

create or replace function public.queue_booking_review_request(
  p_booking_id uuid,
  p_token_hash text,
  p_review_url text,
  p_product_title text,
  p_requested_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.commerce_bookings%rowtype;
  v_event_key text := 'booking-review:' || p_booking_id::text;
begin
  select *
    into v_booking
    from public.commerce_bookings
   where id = p_booking_id
   for update;

  if not found
    or v_booking.status <> 'confirmed'
    or v_booking.review_requested_at is not null
  then
    return false;
  end if;

  -- Heal an interrupted legacy run where the durable outbox event already
  -- exists but the booking marker was not committed.
  if exists (
    select 1
      from public.email_outbox
     where event_key = v_event_key
  ) then
    update public.commerce_bookings
       set review_requested_at = p_requested_at,
           completed_at = p_requested_at,
           status = 'completed'
     where id = p_booking_id;
    return false;
  end if;

  -- A pre-existing, unsubmitted review without an outbox event can only be an
  -- incomplete legacy attempt. Replace its unusable one-way token safely.
  delete from public.booking_reviews
   where booking_id = p_booking_id
     and submitted_at is null;

  -- Never replace a review that the customer already submitted.
  if exists (
    select 1
      from public.booking_reviews
     where booking_id = p_booking_id
  ) then
    update public.commerce_bookings
       set review_requested_at = p_requested_at,
           completed_at = p_requested_at,
           status = 'completed'
     where id = p_booking_id;
    return false;
  end if;

  insert into public.booking_reviews(
    booking_id,
    creator_id,
    reviewer_email,
    reviewer_name,
    token_hash,
    requested_at
  )
  values (
    v_booking.id,
    v_booking.creator_id,
    v_booking.buyer_email,
    v_booking.buyer_name,
    p_token_hash,
    p_requested_at
  );

  insert into public.email_outbox(
    event_key,
    event_type,
    category,
    recipient_email,
    recipient_name,
    payload
  )
  values (
    v_event_key,
    'booking_review_request',
    'transactional',
    lower(trim(v_booking.buyer_email)),
    nullif(trim(v_booking.buyer_name), ''),
    jsonb_build_object(
      'productTitle', coalesce(nullif(trim(p_product_title), ''), 'session'),
      'reviewUrl', p_review_url
    )
  );

  update public.commerce_bookings
     set review_requested_at = p_requested_at,
         completed_at = p_requested_at,
         status = 'completed'
   where id = p_booking_id;

  return true;
end;
$$;

revoke all on function public.queue_booking_review_request(
  uuid,
  text,
  text,
  text,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.queue_booking_review_request(
  uuid,
  text,
  text,
  text,
  timestamptz
) to service_role;
