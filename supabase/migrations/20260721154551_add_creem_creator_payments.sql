-- Add Creem as a creator-owned commerce provider. Credentials continue to use
-- the existing encrypted creator_payment_accounts columns and remain service-role only.

alter table public.profiles
  drop constraint if exists profiles_commerce_payment_provider_check;
alter table public.profiles
  add constraint profiles_commerce_payment_provider_check
  check (
    commerce_payment_provider is null or
    commerce_payment_provider in ('stripe', 'paypal', 'razorpay', 'polar', 'dodo', 'creem')
  );
