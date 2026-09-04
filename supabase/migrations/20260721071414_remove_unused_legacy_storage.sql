-- Remove superseded storage after verifying on staging and production that:
--   * each table below contains zero rows;
--   * no view, function, or foreign key depends on any of them; and
--   * both legacy Stripe profile columns contain zero non-null values.
--
-- Current replacements:
--   email_signups             -> commerce_leads
--   tips                      -> commerce_products / commerce_orders
--   commerce_payout_requests  -> connected provider owns creator payouts
--   profiles Stripe columns   -> creator_payment_accounts

set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop table public.commerce_payout_requests;
drop table public.email_signups;
drop table public.tips;

alter table public.profiles
  drop column stripe_account_id,
  drop column stripe_customer_id;
