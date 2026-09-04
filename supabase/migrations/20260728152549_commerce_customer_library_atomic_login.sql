-- Consume a customer-library magic link and create its session in one transaction.
-- The function accepts hashes only; raw capability tokens never enter Postgres.

create or replace function public.consume_commerce_customer_magic_link(
  p_token_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz
)
returns table(customer_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  update public.commerce_customer_magic_links
  set used_at = now()
  where token_hash = p_token_hash
    and used_at is null
    and expires_at > now()
  returning commerce_customer_magic_links.customer_id into v_customer_id;

  if v_customer_id is null then
    return;
  end if;

  insert into public.commerce_customer_sessions (
    customer_id,
    token_hash,
    expires_at
  )
  values (
    v_customer_id,
    p_session_token_hash,
    p_session_expires_at
  );

  return query select v_customer_id;
end;
$$;

revoke all on function public.consume_commerce_customer_magic_link(text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.consume_commerce_customer_magic_link(text, text, timestamptz)
to service_role;
