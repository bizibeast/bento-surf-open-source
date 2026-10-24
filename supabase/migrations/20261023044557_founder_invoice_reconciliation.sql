-- Verified invoice evidence fills provider omissions; it is never a second expense.
alter table public.founder_service_expenses
  add column provider_account_id text,
  add column provider_invoice_id text,
  add column provider_invoice_date date,
  add column evidence_reference text,
  add column evidence_sha256 text,
  add column evidence_verified_at timestamptz,
  add column evidence_verified_by uuid;

alter table public.founder_service_expenses
  add constraint founder_service_expenses_reconciliation_check check (
    num_nonnulls(provider_account_id,provider_invoice_id,provider_invoice_date,
      evidence_reference,evidence_sha256,evidence_verified_at,evidence_verified_by)=0
    or (
      num_nonnulls(provider_account_id,provider_invoice_id,provider_invoice_date,
        evidence_reference,evidence_sha256,evidence_verified_at,evidence_verified_by)=7
      and provider='Cloudflare'
      and provider_account_id ~ '^[a-f0-9]{32}$'
      and length(provider_invoice_id) between 1 and 200
      and length(evidence_reference) between 1 and 500
      and evidence_sha256 ~ '^[a-f0-9]{64}$'
      and period_start=provider_invoice_date
      and period_end=provider_invoice_date
    )
  );

create unique index founder_service_expenses_provider_invoice_idx
  on public.founder_service_expenses(provider,provider_account_id,provider_invoice_id,currency,provider_invoice_date)
  where provider_invoice_id is not null;

comment on column public.founder_service_expenses.provider_invoice_id is
  'Operator reconciliation, excluded from manual expense totals. Match exact account/invoice/currency/date and fill only an absent API amount.';
comment on column public.founder_service_expenses.evidence_sha256 is
  'SHA-256 of the operator-reviewed source invoice document or official dashboard evidence; never a credential or an inferred zero.';
-- Existing service-role-only grants and RLS stay unchanged.
