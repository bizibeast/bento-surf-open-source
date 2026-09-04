create or replace function public.archive_audience_contacts(
  p_creator_id uuid,
  p_contact_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  transitioned_count integer;
begin
  if p_creator_id is null
    or cardinality(p_contact_ids) is null
    or cardinality(p_contact_ids) < 1
    or cardinality(p_contact_ids) > 100
    or cardinality(p_contact_ids) <> cardinality(array(select distinct id from unnest(p_contact_ids) id)) then
    raise exception 'Archive request must contain 1 to 100 unique contact IDs';
  end if;

  perform 1
  from public.profiles profile
  where profile.id = p_creator_id
  for update;

  if not found then
    raise exception 'Creator profile was not found';
  end if;

  with locked_contacts as (
    select contact.id
    from public.audience_contacts contact
    where contact.creator_id = p_creator_id
      and contact.id = any(p_contact_ids)
      and contact.marketing_status = 'subscribed'
    for update
  ), inserted_events as (
    insert into public.audience_consent_events(creator_id, contact_id, status, source)
    select p_creator_id, contact.id, 'unsubscribed', 'creator_archive'
    from locked_contacts contact
    returning id
  )
  select count(*)::integer
  into transitioned_count
  from inserted_events;

  return transitioned_count;
end;
$$;

revoke all on function public.archive_audience_contacts(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.archive_audience_contacts(uuid, uuid[]) to service_role;
