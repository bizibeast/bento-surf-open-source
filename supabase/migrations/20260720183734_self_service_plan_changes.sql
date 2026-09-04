-- Keep scheduled subscription changes visible and durable while Dodo remains
-- the billing authority. Existing paid access is left untouched until Dodo
-- confirms that the new product became effective.
alter table public.subscriptions
  add column if not exists pending_plan_id text,
  add column if not exists pending_plan_effective_at timestamptz;

alter table public.subscriptions
  drop constraint if exists subscriptions_pending_plan_id_check;

alter table public.subscriptions
  add constraint subscriptions_pending_plan_id_check
  check (pending_plan_id is null or pending_plan_id in ('link', 'store'));

comment on column public.subscriptions.pending_plan_id is
  'Paid plan requested through Dodo but not effective yet.';
comment on column public.subscriptions.pending_plan_effective_at is
  'When a scheduled paid-plan change will take effect; null means processing now.';
