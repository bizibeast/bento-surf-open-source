-- A creation preference only: existing product currencies and amounts are unchanged.
alter table public.profiles
  add column commerce_default_currency text not null default 'usd'
  constraint profiles_commerce_default_currency_check
  check (commerce_default_currency in ('usd', 'inr', 'eur', 'gbp', 'aud', 'cad'));

comment on column public.profiles.commerce_default_currency is
  'Initial currency for new Store product drafts. Changing it never reprices existing products.';

-- Continue relying on the existing owner/workspace RLS policies. Profile access
-- is column-scoped; this preference does not grant access to billing internals.
grant select (commerce_default_currency) on public.profiles to authenticated;
grant update (commerce_default_currency) on public.profiles to authenticated;

notify pgrst, 'reload schema';
