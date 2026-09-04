-- Publish a Fathom recording and queue its customer email as one transaction.
--
-- The previous scheduler marked the recording ready before creating the email
-- outbox row. A transient outbox failure could therefore suppress the
-- recording email permanently. This privileged transition locks the booking,
-- validates the recording URL, and commits both changes together.

create or replace function public.queue_booking_recording_ready(
  p_booking_id uuid,
  p_recording_share_url text,
  p_product_title text,
  p_recorded_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.commerce_bookings%rowtype;
  v_event_key text := 'booking-recording:' || p_booking_id::text;
  v_recording_url text := trim(p_recording_share_url);
begin
  if v_recording_url !~* '^https://[^[:space:]]+$'
    or octet_length(v_recording_url) > 2048
  then
    raise exception 'A valid secure recording URL is required.'
      using errcode = '22023';
  end if;

  select *
    into v_booking
    from public.commerce_bookings
   where id = p_booking_id
   for update;

  if not found
    or not v_booking.recording_requested
    or v_booking.recording_status <> 'pending'
    or v_booking.status not in ('confirmed', 'completed')
  then
    return false;
  end if;

  -- Heal an interrupted legacy run where an outbox event already exists.
  if exists (
    select 1
      from public.email_outbox
     where event_key = v_event_key
  ) then
    update public.commerce_bookings
       set recording_status = 'ready',
           recording_share_url = v_recording_url,
           updated_at = p_recorded_at
     where id = p_booking_id;
    return false;
  end if;

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
    'booking_recording_ready',
    'transactional',
    lower(trim(v_booking.buyer_email)),
    nullif(trim(v_booking.buyer_name), ''),
    jsonb_build_object(
      'productTitle', coalesce(nullif(trim(p_product_title), ''), 'session'),
      'recordingUrl', v_recording_url
    )
  );

  update public.commerce_bookings
     set recording_status = 'ready',
         recording_share_url = v_recording_url,
         updated_at = p_recorded_at
   where id = p_booking_id;

  return true;
end;
$$;

-- Repair legacy ready recordings whose state was committed before their email.
insert into public.email_outbox(
  event_key,
  event_type,
  category,
  recipient_email,
  recipient_name,
  payload
)
select
  'booking-recording:' || booking.id::text,
  'booking_recording_ready',
  'transactional',
  lower(trim(booking.buyer_email)),
  nullif(trim(booking.buyer_name), ''),
  jsonb_build_object(
    'productTitle', coalesce(nullif(trim(product.title), ''), 'session'),
    'recordingUrl', trim(booking.recording_share_url)
  )
from public.commerce_bookings booking
join public.commerce_products product on product.id = booking.product_id
where booking.recording_requested
  and booking.recording_status = 'ready'
  and booking.recording_share_url ~* '^https://[^[:space:]]+$'
  and octet_length(trim(booking.recording_share_url)) <= 2048
  and booking.buyer_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
on conflict (event_key) do nothing;

revoke all on function public.queue_booking_recording_ready(
  uuid,
  text,
  text,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.queue_booking_recording_ready(
  uuid,
  text,
  text,
  timestamptz
) to service_role;
