-- Empty disposable local PostgreSQL only. Synthetic data; entire fixture rolls back.
begin;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.founder_service_expenses(
  id uuid primary key default gen_random_uuid(),
  provider text not null check(length(provider) between 2 and 80),
  amount_minor bigint not null check(amount_minor>=0),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  period_start date not null,period_end date not null,
  note text not null default '' check(length(note)<=300),
  created_at timestamptz not null default now(),
  check(period_end>=period_start)
);
alter table public.founder_service_expenses enable row level security;
revoke all on public.founder_service_expenses from public,anon,authenticated;
grant all on public.founder_service_expenses to service_role;
\ir ../migrations/20261023044557_founder_invoice_reconciliation.sql

insert into public.founder_service_expenses(provider,amount_minor,currency,period_start,period_end)
values('Example provider',500,'USD','2026-09-01','2026-09-30');
insert into public.founder_service_expenses(id,provider,amount_minor,currency,period_start,period_end,
  provider_account_id,provider_invoice_id,provider_invoice_date,evidence_reference,evidence_sha256,evidence_verified_at,evidence_verified_by)
values('00000000-0000-4000-8000-000000000001','Cloudflare',0,'USD','2026-09-15','2026-09-15',
  repeat('a',32),'invoice-fixture','2026-09-15','Invoice PDF fixture',repeat('b',64),now(),'00000000-0000-4000-8000-000000000002');

do $$ begin
  if (select count(*) from public.founder_service_expenses where provider_invoice_id is null)<>1 or
     (select sum(amount_minor) from public.founder_service_expenses where provider_invoice_id is null)<>500 then
    raise exception 'Invoice reconciliation was double-counted as a manual expense';
  end if;
  delete from public.founder_service_expenses where id='00000000-0000-4000-8000-000000000001' and provider_invoice_id is null;
  if not exists(select from public.founder_service_expenses where provider_invoice_id='invoice-fixture') then
    raise exception 'Ordinary expense deletion removed operator evidence';
  end if;
  begin
    insert into public.founder_service_expenses(provider,amount_minor,currency,period_start,period_end,provider_invoice_id)
    values('Cloudflare',0,'USD','2026-09-15','2026-09-15','partial-proof');
    raise exception 'Incomplete reconciliation accepted';
  exception when check_violation then null; end;
  begin
    update public.founder_service_expenses set evidence_sha256='not-a-hash' where provider_invoice_id='invoice-fixture';
    raise exception 'Malformed proof accepted';
  exception when check_violation then null; end;
  begin
    update public.founder_service_expenses set provider_invoice_date='2026-09-16' where provider_invoice_id='invoice-fixture';
    raise exception 'Mismatched invoice date accepted';
  exception when check_violation then null; end;
  begin
    insert into public.founder_service_expenses(provider,amount_minor,currency,period_start,period_end,
      provider_account_id,provider_invoice_id,provider_invoice_date,evidence_reference,evidence_sha256,evidence_verified_at,evidence_verified_by)
    select provider,amount_minor,currency,period_start,period_end,
      provider_account_id,provider_invoice_id,provider_invoice_date,evidence_reference,evidence_sha256,evidence_verified_at,evidence_verified_by
      from public.founder_service_expenses where provider_invoice_id='invoice-fixture';
    raise exception 'Duplicate reconciliation accepted';
  exception when unique_violation then null; end;
  if has_table_privilege('anon','public.founder_service_expenses','select') or
     has_table_privilege('authenticated','public.founder_service_expenses','select') or
     has_table_privilege('authenticated','public.founder_service_expenses','insert') then
    raise exception 'Private invoice evidence exposed';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.founder_service_expenses'::regclass) then
    raise exception 'Invoice RLS disabled';
  end if;
  raise notice 'PASS: exact invoice uniqueness, complete proof/date constraints, separate manual totals/deletion, unchanged private grants';
end $$;
rollback;
