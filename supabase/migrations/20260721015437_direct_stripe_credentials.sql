-- Direct creator-owned payment credentials. Stripe restricted keys are
-- encrypted by the Worker before they reach this table. Browser roles retain
-- no access to the row, encrypted credential, or webhook signing secret.

alter table public.creator_payment_accounts
  add column if not exists credential_mode text not null default 'oauth',
  add column if not exists credential_fingerprint text;

alter table public.creator_payment_accounts
  drop constraint if exists creator_payment_accounts_credential_mode_check;
alter table public.creator_payment_accounts
  add constraint creator_payment_accounts_credential_mode_check
  check (credential_mode in ('oauth', 'restricted_key', 'api_key'));

create index if not exists creator_payment_accounts_credential_mode_idx
  on public.creator_payment_accounts(provider, credential_mode);

comment on column public.creator_payment_accounts.credential_mode is
  'How Bento authenticates to the creator-owned provider account. Secrets remain encrypted.';
comment on column public.creator_payment_accounts.credential_fingerprint is
  'SHA-256 fingerprint used only for credential rotation checks; never the credential itself.';

revoke all on public.creator_payment_accounts from anon, authenticated;
grant all on public.creator_payment_accounts to service_role;
