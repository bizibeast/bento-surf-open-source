#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="${BENTO_SUPABASE_DB_CONTAINER:?Set BENTO_SUPABASE_DB_CONTAINER to your local Supabase PostgreSQL container}"
database="${BENTO_SUBSCRIPTION_TEST_DATABASE:?Set BENTO_SUBSCRIPTION_TEST_DATABASE to an isolated local database with current migrations applied}"
psql_test() { docker exec -i "$container" psql -X -qAt -U postgres -d "$database" -v ON_ERROR_STOP=1 "$@"; }
psql_test < supabase/tests/subscription_period_funding_financial_access.sql
funding_logs="$(mktemp -d /tmp/bento-funding-races.XXXXXX)"
funding_owners=()
cleanup() {
  for funding_owner in "${funding_owners[@]}"; do
    psql_test -v owner="$funding_owner" <<'SQL' || true
begin;
delete from public.commerce_order_events where creator_id=:'owner'::uuid;
delete from public.commerce_subscription_access where creator_id=:'owner'::uuid;
delete from public.commerce_access_grants where creator_id=:'owner'::uuid;
delete from public.commerce_orders where creator_id=:'owner'::uuid;
delete from public.commerce_products where creator_id=:'owner'::uuid;
delete from public.creator_payment_accounts where creator_id=:'owner'::uuid;
delete from auth.users where id=:'owner'::uuid;
commit;
SQL
  done
}
trap cleanup EXIT
for funding_provider in stripe paypal razorpay dodo creem polar; do
  for funding_event in refund dispute; do
    funding_fixture="$(psql_test -v provider="$funding_provider" <<'SQL'
create function pg_temp.funding_race_fixture(p_provider text) returns text language plpgsql as $$
declare u uuid:=gen_random_uuid(); a uuid; p uuid; s uuid; first_paid jsonb; second_paid jsonb; g uuid;
 start_at timestamptz:=now()+interval '1 day'; end_at timestamptz:=now()+interval '1 month 1 day';
 account_name text:='race-'||u; sub_name text:='race-sub-'||u;
begin
 insert into auth.users(id,email) values(u,'race-'||u||'@example.test');
 insert into public.creator_payment_accounts(creator_id,provider,provider_account_id) values(u,p_provider,account_name) returning id into a;
 insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
 values(u,'membership','published','race-'||u,'race-'||u,'Race membership','subscription',1000,'usd','month') returning id into p;
 insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
 values(p,u,a,p_provider,sub_name,'buyer@example.test',1000,0,0,'usd','race-token-'||u) returning id into s;
 first_paid:=public.fulfill_provider_commerce_order_with_period(p,'buyer@example.test','Buyer',p_provider,account_name,sub_name,sub_name||'-1',sub_name,
 1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',s),'race-token-'||u,start_at-interval '1 month',start_at);
 select id into strict g from public.commerce_access_grants where order_id=(first_paid->>'order_id')::uuid;
 second_paid:=public.fulfill_provider_commerce_order_with_period(p,'buyer@example.test','Buyer',p_provider,account_name,sub_name,sub_name||'-2',sub_name,
 1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',s),'race-token-'||u);
 return u||'|'||s||'|'||account_name||'|'||sub_name||'|'||(first_paid->>'order_id')||'|'||(second_paid->>'order_id')||'|'||g||'|'||start_at||'|'||end_at;
end;
$$;
select pg_temp.funding_race_fixture(:'provider');
SQL
)"
    IFS='|' read -r funding_owner funding_session funding_account funding_sub funding_first funding_second funding_grant funding_start funding_end <<< "$funding_fixture"
    funding_owners+=("$funding_owner")
    psql_test -v session="$funding_session" -v start="$funding_start" -v end="$funding_end" >"$funding_logs/$funding_provider-$funding_event-paid.log" 2>&1 <<'SQL' &
begin;
set local statement_timeout='8s';
set local lock_timeout='5s';
select public.fulfill_provider_commerce_order_with_period(s.product_id,s.buyer_email,'Buyer',s.provider,a.provider_account_id,s.provider_checkout_id,s.provider_checkout_id||'-2',s.provider_checkout_id,
 1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',s.id),s.access_token_hash,:'start'::timestamptz,:'end'::timestamptz)
 from public.commerce_payment_sessions s join public.creator_payment_accounts a on a.id=s.connection_id where s.id=:'session'::uuid;
select pg_sleep(0.2);
commit;
SQL
    funding_paid_pid=$!
    psql_test -v provider="$funding_provider" -v event="$funding_event" -v account="$funding_account" -v sub="$funding_sub" >"$funding_logs/$funding_provider-$funding_event-financial.log" 2>&1 <<'SQL' &
begin;
set local statement_timeout='8s';
set local lock_timeout='5s';
select case when :'event'='refund' then public.apply_commerce_refund(:'provider',:'sub'||'-2',:'account',:'sub'||'-refund',1000)
 else public.apply_commerce_dispute_guarded(:'provider',:'sub'||'-2',:'account',:'sub'||'-dispute','dispute-'||:'sub','open',1000) end;
select pg_sleep(0.2);
commit;
SQL
    funding_financial_pid=$!
    if ! wait "$funding_paid_pid" || ! wait "$funding_financial_pid"; then
      cat "$funding_logs/$funding_provider-$funding_event-paid.log" "$funding_logs/$funding_provider-$funding_event-financial.log"
      exit 1
    fi
    psql_test -v provider="$funding_provider" -v sub="$funding_sub" -v account="$funding_account" -v first="$funding_first" -v second="$funding_second" -v grant="$funding_grant" -v start="$funding_start" -v end="$funding_end" <<'SQL'
select public.apply_commerce_subscription_lifecycle_funded(:'provider',:'account',:'sub','active','race-unfunded-status',null,:'end'::timestamptz+interval '1 year');
create temporary table race_assertion(value boolean not null check(value));
insert into race_assertion select
 (s.funding_order_id=:'second'::uuid and g.status='revoked')
 or (s.funding_order_id=:'first'::uuid and s.current_period_end=:'start'::timestamptz
     and g.expires_at<=:'start'::timestamptz+interval '3 days')
 from public.commerce_subscription_access s join public.commerce_access_grants g on g.id=s.access_grant_id
 where s.provider=:'provider' and s.provider_account_id=:'account' and s.provider_subscription_id=:'sub' and g.id=:'grant'::uuid;
insert into race_assertion values ((select count(*) from race_assertion)=1);
SQL
  done
done
printf 'PASS: six-provider financial funding SQL and concurrent refund/dispute races\n'
