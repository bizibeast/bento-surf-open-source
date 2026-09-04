-- Cloudflare for SaaS includes 100 custom hostnames before metered billing.
-- Keep a ten-hostname operational buffer so app traffic cannot create spend.
create or replace function public.enforce_custom_domain_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serialize reservations so concurrent requests cannot cross the ceiling.
  perform pg_advisory_xact_lock(hashtextextended('custom_domains_capacity', 0));

  if (select count(*) from public.custom_domains) >= 90 then
    raise exception using
      errcode = 'P0001',
      message = 'Custom domain capacity has been reached.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_custom_domain_capacity() from public;

create trigger custom_domains_capacity_guard
  before insert on public.custom_domains
  for each row execute function public.enforce_custom_domain_capacity();
