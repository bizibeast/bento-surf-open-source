-- Backfill eligible creators separately so the schema migration stays fast and
-- independently reversible during staging validation.
insert into public.referral_accounts(user_id, code)
select
  p.id,
  case
    when lower(p.username) ~ '^[a-z0-9]([a-z0-9-]{1,22}[a-z0-9])?$'
      and lower(p.username) not in ('admin','api','dashboard','earn','home','login','onboarding','r','settings','signup')
      then lower(p.username) || '-' || left(replace(p.id::text, '-', ''), 6)
    else 'creator-' || left(replace(p.id::text, '-', ''), 12)
  end
from public.profiles p
on conflict (user_id) do nothing;

-- Legacy click counts remain historical Store analytics. No anonymous legacy
-- click is retroactively attributed to a customer or granted commission.
