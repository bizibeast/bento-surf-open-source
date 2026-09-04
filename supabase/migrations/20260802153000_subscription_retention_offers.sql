-- A paid creator can redeem Bento's three-month save offer once. The provider
-- remains the billing authority; these fields make the offer idempotent and
-- keep the resulting access date visible in account settings.
alter table public.subscriptions
  add column if not exists retention_offer_redeemed_at timestamptz,
  add column if not exists retention_offer_expires_at timestamptz,
  add column if not exists retention_offer_reason text;

comment on column public.subscriptions.retention_offer_redeemed_at is
  'When the one-time three-month subscription retention offer was claimed.';
comment on column public.subscriptions.retention_offer_expires_at is
  'Provider-confirmed access date after applying the retention extension.';
comment on column public.subscriptions.retention_offer_reason is
  'Cancellation survey reason that led to the one-time retention extension.';
