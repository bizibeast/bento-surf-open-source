-- Old reservations remain unverified and require reconciliation rather than
-- returning a checkout whose product or payment requirements may have changed.
alter table public.bento_trial_checkouts add column trial_verification_key text;
comment on column public.bento_trial_checkouts.trial_verification_key is
  'Service-verified free card trial policy version, provider environment and product identity.';
notify pgrst, 'reload schema';
