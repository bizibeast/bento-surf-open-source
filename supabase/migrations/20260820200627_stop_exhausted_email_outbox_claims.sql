begin;

update public.email_outbox
set status = 'failed',
    last_error = coalesce(last_error, 'Delivery attempts exhausted.'),
    updated_at = now()
where status in ('pending', 'processing')
  and attempts >= 20;

create or replace function public.claim_email_outbox(p_limit integer default 25)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with claimed as (
    select email.id
    from public.email_outbox email
    where email.attempts < 20
      and (
        (email.status = 'pending' and email.available_at <= now())
        or (
          email.status = 'processing'
          and email.updated_at <= now() - interval '10 minutes'
        )
      )
    order by email.available_at, email.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.email_outbox email
  set status = 'processing', attempts = email.attempts + 1, updated_at = now()
  from claimed
  where email.id = claimed.id
  returning email.*;
end;
$$;

revoke all on function public.claim_email_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_email_outbox(integer) to service_role;

commit;

notify pgrst, 'reload schema';
