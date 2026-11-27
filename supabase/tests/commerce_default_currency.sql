-- Run with psql -v ON_ERROR_STOP=1 against a disposable local database with all
-- preceding migrations. This test applies the currency migration transactionally.
-- Synthetic fixtures only; every schema/data change rolls back.
begin;

insert into auth.users(id,email) values
  ('d3110000-0000-4000-8000-000000000001','currency-owner@example.test'),
  ('d3110000-0000-4000-8000-000000000002','currency-other@example.test');
insert into public.profiles(id,username,display_name)
values ('d3110000-0000-4000-8000-000000000003','currency_second','Second owned workspace');
insert into public.workspace_memberships(auth_user_id,workspace_id)
values ('d3110000-0000-4000-8000-000000000001','d3110000-0000-4000-8000-000000000003');
insert into public.commerce_products(id,creator_id,kind,slug,public_slug,title,price_amount,currency)
values ('d3110000-0000-4000-8000-000000000004','d3110000-0000-4000-8000-000000000003',
  'digital_product','currency-existing-product','existing-product','Existing product',1299,'gbp');

\ir ../migrations/20261126181648_commerce_default_currency.sql

do $$ begin
  if exists(select 1 from public.profiles where commerce_default_currency<>'usd') then
    raise exception 'Existing profiles did not receive USD default';
  end if;
  if not has_column_privilege('authenticated','public.profiles','commerce_default_currency','SELECT')
    or not has_column_privilege('authenticated','public.profiles','commerce_default_currency','UPDATE') then
    raise exception 'Missing authenticated column grants';
  end if;
  if has_column_privilege('anon','public.profiles','commerce_default_currency','SELECT')
    or has_column_privilege('anon','public.profiles','commerce_default_currency','UPDATE') then
    raise exception 'Anonymous default currency access granted';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','d3110000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"d3110000-0000-4000-8000-000000000001","role":"authenticated"}',true);

do $$ declare affected integer; currency text; begin
  update public.profiles set commerce_default_currency='inr'
    where id='d3110000-0000-4000-8000-000000000003';
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'Owned workspace preference did not save'; end if;
  select commerce_default_currency into currency from public.profiles
    where id='d3110000-0000-4000-8000-000000000003';
  if currency<>'inr' then raise exception 'Saved preference did not persist'; end if;

  update public.profiles set commerce_default_currency='eur'
    where id='d3110000-0000-4000-8000-000000000002';
  get diagnostics affected=row_count;
  if affected<>0 then raise exception 'Another owner currency was changed'; end if;
  if exists(select 1 from public.profiles where id='d3110000-0000-4000-8000-000000000002') then
    raise exception 'Another owner profile was readable';
  end if;

  begin
    update public.profiles set commerce_default_currency='jpy'
      where id='d3110000-0000-4000-8000-000000000003';
    raise exception 'Unsupported currency was accepted';
  exception when check_violation then null; end;
  begin
    update public.profiles set commerce_default_currency=null
      where id='d3110000-0000-4000-8000-000000000003';
    raise exception 'Null currency was accepted';
  exception when not_null_violation then null; end;
end $$;
reset role;

do $$ begin
  if (select commerce_default_currency from public.profiles where id='d3110000-0000-4000-8000-000000000001')<>'usd'
    or (select commerce_default_currency from public.profiles where id='d3110000-0000-4000-8000-000000000002')<>'usd' then
    raise exception 'Changing one workspace affected other defaults';
  end if;
  if not exists(select 1 from public.commerce_products
    where id='d3110000-0000-4000-8000-000000000004' and currency='gbp' and price_amount=1299) then
    raise exception 'Changing default currency repriced an existing product';
  end if;
  raise notice 'PASS: default backfill, column grants, owner persistence, workspace isolation, invalid values and existing prices';
end $$;
rollback;
