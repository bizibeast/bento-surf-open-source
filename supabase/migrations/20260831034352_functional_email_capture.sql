create or replace function public.capture_public_email_audience(
  p_block_id uuid,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator_row_id uuid;
  contact_row_id uuid;
  current_marketing_status text;
  normalized_email text := lower(trim(p_email));
begin
  if normalized_email is null or normalized_email = '' or length(normalized_email) > 254 then
    raise exception 'A valid email is required';
  end if;

  select user_id
  into creator_row_id
  from public.blocks
  where id = p_block_id and type = 'email_capture'
  for update;

  if not found then
    raise exception 'Email capture block not found';
  end if;

  contact_row_id := public.commerce_upsert_audience_contact(
    creator_row_id,
    normalized_email,
    null,
    'email_capture_block',
    now()
  );

  insert into public.audience_events(
    creator_id,
    contact_id,
    event_type,
    source_type,
    source_id,
    dedupe_key,
    metadata
  )
  values (
    creator_row_id,
    contact_row_id,
    'email_captured',
    'email_capture_block',
    p_block_id,
    'email-capture:' || p_block_id || ':' || contact_row_id,
    jsonb_build_object('block_id', p_block_id)
  )
  on conflict (creator_id, dedupe_key) do nothing;

  select marketing_status
  into current_marketing_status
  from public.audience_contacts
  where id = contact_row_id and creator_id = creator_row_id
  for update;

  if current_marketing_status is distinct from 'subscribed' then
    insert into public.audience_consent_events(
      creator_id,
      contact_id,
      status,
      source,
      proof
    )
    values (
      creator_row_id,
      contact_row_id,
      'subscribed',
      'email_capture_block',
      jsonb_build_object('block_id', p_block_id, 'disclosure', 'creator_updates')
    );
  end if;

  return contact_row_id;
end;
$$;

revoke all on function public.capture_public_email_audience(uuid, text) from public, anon, authenticated;
grant execute on function public.capture_public_email_audience(uuid, text) to service_role;
