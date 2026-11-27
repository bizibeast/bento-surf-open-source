-- Run with psql -v ON_ERROR_STOP=1 after migrations. Fixtures always roll back.
begin;

create function pg_temp.fulfill_subscription_test(
  p_session_id uuid, p_payment_id text, p_subscription_id text,
  p_override jsonb default '{}'::jsonb
) returns jsonb language plpgsql as $$
declare s public.commerce_payment_sessions%rowtype;
begin
  select * into strict s from public.commerce_payment_sessions where id = p_session_id;
  return public.fulfill_provider_commerce_order(
    coalesce((p_override->>'product_id')::uuid, s.product_id),
    coalesce(p_override->>'buyer_email', s.buyer_email), 'Original buyer', s.provider,
    case when p_override ? 'account_id' then p_override->>'account_id' else
      (select provider_account_id from public.creator_payment_accounts where id = s.connection_id) end,
    coalesce(p_override->>'checkout_id', s.provider_checkout_id), p_payment_id, p_subscription_id,
    coalesce((p_override->>'gross_amount')::integer, s.gross_amount),
    s.platform_fee_bps, s.platform_fee_amount, 0, 0,
    coalesce((p_override->>'gross_amount')::integer, s.gross_amount) - s.platform_fee_amount,
    coalesce(p_override->>'currency', s.currency),
    jsonb_build_object('bento_session_id', s.id::text)
      || coalesce(p_override->'metadata', '{}'::jsonb),
    coalesce(p_override->>'token_hash', s.access_token_hash)
  );
end;
$$;

do $$
declare
 owner_id uuid := gen_random_uuid(); account_id uuid; product_id uuid; session_id uuid;
 provider_name text; scenario text; subscription_id text; first_result jsonb; renewal_result jsonb;
 durable_grant uuid; actual text; expected text; failures text[] := '{}';
begin
 insert into auth.users(id,email) values(owner_id, 'funding-'||owner_id||'@example.test');
 foreach provider_name in array array['stripe','paypal','razorpay','dodo','creem','polar'] loop
  insert into public.creator_payment_accounts(creator_id,provider,provider_account_id)
   values(owner_id,provider_name,provider_name||'-funding-account') returning id into account_id;
  foreach scenario in array array['current_refund','old_refund','partial_refund','current_dispute','old_dispute','won_dispute','same_period_replacement'] loop
   subscription_id := provider_name||'-'||scenario;
   insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
    values(owner_id,'membership','published','fund-'||gen_random_uuid(),'fund-'||gen_random_uuid(),'Membership','subscription',1000,'usd','month') returning id into product_id;
   insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
    values(product_id,owner_id,account_id,provider_name,subscription_id,'buyer@example.test',1000,0,0,'usd',subscription_id||'-token') returning id into session_id;
   first_result := pg_temp.fulfill_subscription_test(session_id, subscription_id||'-payment-1',subscription_id);
   select g.id into strict durable_grant from public.commerce_access_grants g where g.order_id=(first_result->>'order_id')::uuid;
   perform public.apply_commerce_subscription_lifecycle_funded(provider_name,provider_name||'-funding-account',subscription_id,'renewed',subscription_id||'-paid-1',now()-interval '1 month',now()-interval '1 day',p_funding_order_id=>(first_result->>'order_id')::uuid);
   renewal_result := pg_temp.fulfill_subscription_test(session_id, subscription_id||'-payment-2',subscription_id);
   perform public.apply_commerce_subscription_lifecycle_funded(provider_name,provider_name||'-funding-account',subscription_id,'renewed',subscription_id||'-paid-2',now()-interval '1 day',now()+interval '1 month',p_funding_order_id=>(renewal_result->>'order_id')::uuid);
   if scenario in ('current_refund','old_refund','partial_refund','same_period_replacement') then
    perform public.apply_commerce_refund(provider_name,subscription_id||case when scenario='old_refund' then '-payment-1' else '-payment-2' end,provider_name||'-funding-account',subscription_id||'-refund',case when scenario='partial_refund' then 500 else 1000 end,true,'{}',now());
   else
    perform public.apply_commerce_dispute_guarded(provider_name,subscription_id||case when scenario='old_dispute' then '-payment-1' else '-payment-2' end,provider_name||'-funding-account',subscription_id||'-dispute-open','dispute-'||subscription_id,'open',1000,null,'{}',now());
    if scenario='won_dispute' then
     perform public.apply_commerce_dispute_guarded(provider_name,subscription_id||'-payment-2',provider_name||'-funding-account',subscription_id||'-dispute-won','dispute-'||subscription_id,'won',1000,null,'{}',now()+interval '1 second');
    end if;
   end if;
   if scenario='same_period_replacement' then
    renewal_result := pg_temp.fulfill_subscription_test(session_id,subscription_id||'-replacement-payment',subscription_id);
    perform public.apply_commerce_subscription_lifecycle_funded(provider_name,provider_name||'-funding-account',subscription_id,'renewed',subscription_id||'-replacement-paid',now()-interval '1 day',now()+interval '1 month',p_funding_order_id=>(renewal_result->>'order_id')::uuid);
   end if;
   expected := case when scenario in ('current_refund','current_dispute') then 'revoked' else 'active' end;
   select g.status::text into actual from public.commerce_access_grants g where g.id=durable_grant;
   if actual is distinct from expected then failures := array_append(failures,provider_name||':'||scenario||' expected '||expected||' got '||actual); end if;
  end loop;
 end loop;
 if cardinality(failures)>0 then raise exception 'Funding regressions: %',array_to_string(failures,E'\n'); end if;
end;
$$;
-- Free purchases and moderator grants are outside subscription funding.
do $$
declare owner_id uuid:=gen_random_uuid(); product_id uuid; order_id uuid; grant_id uuid;
begin
 insert into auth.users(id,email) values(owner_id,'free-funding-'||owner_id||'@example.test');
 insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency)
 values(owner_id,'paid_community','published','free-'||gen_random_uuid(),'free-'||gen_random_uuid(),'Free community','free',0,'usd') returning id into product_id;
 insert into public.commerce_orders(product_id,creator_id,buyer_email,status,provider,provider_checkout_id,gross_amount,platform_fee_bps,platform_fee_amount,processor_fee_amount,tax_amount,net_amount,currency,paid_at)
 values(product_id,owner_id,'free@example.test','paid','free','free-'||gen_random_uuid(),0,0,0,0,0,0,'usd',now()) returning id into order_id;
 foreach grant_id in array array[gen_random_uuid(),gen_random_uuid()] loop
  insert into public.commerce_access_grants(id,order_id,product_id,creator_id,buyer_email,token_hash)
  values(grant_id,order_id,product_id,owner_id,'free@example.test',grant_id::text);
  if (select g.status from public.commerce_access_grants g where g.id=grant_id)<>'active' then raise exception 'Free/null-order grant revoked on insert'; end if;
  update public.commerce_access_grants g set status='revoked' where g.id=grant_id;
  update public.commerce_access_grants g set status='active' where g.id=grant_id;
  if (select g.status from public.commerce_access_grants g where g.id=grant_id)<>'active' then raise exception 'Free/null-order grant revoked on status update'; end if;
  order_id:=null;
 end loop;
end;
$$;

-- A new verified payment retains the same historical inventory seat even when
-- the sole previous payment was refunded or disputed. Financially bad history
-- never activates access by itself.
do $$
declare owner_id uuid:=gen_random_uuid(); account_id uuid; product_id uuid; session_id uuid;
 provider_name text; scenario text; sub_id text; first_result jsonb; next_result jsonb; grant_id uuid;
begin
 insert into auth.users(id,email) values(owner_id,'first-recovery-'||owner_id||'@example.test');
 foreach provider_name in array array['stripe','paypal','razorpay','dodo','creem','polar'] loop
  insert into public.creator_payment_accounts(creator_id,provider,provider_account_id)
  values(owner_id,provider_name,provider_name||'-recovery-account') returning id into account_id;
  foreach scenario in array array['refund','dispute'] loop
   sub_id:=provider_name||'-first-'||scenario;
   insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval,inventory_limit)
   values(owner_id,'membership','published','recovery-'||gen_random_uuid(),'recovery-'||gen_random_uuid(),'Membership','subscription',1000,'usd','month',1) returning id into product_id;
   insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
   values(product_id,owner_id,account_id,provider_name,sub_id,'buyer@example.test',1000,0,0,'usd',sub_id||'-token') returning id into session_id;
   first_result:=pg_temp.fulfill_subscription_test(session_id,sub_id||'-first',sub_id);
   select g.id into strict grant_id from public.commerce_access_grants g where g.order_id=(first_result->>'order_id')::uuid;
   perform public.apply_commerce_subscription_lifecycle_funded(provider_name,provider_name||'-recovery-account',sub_id,'renewed',sub_id||'-paid-first',now()-interval '1 month',now()-interval '1 day',p_funding_order_id=>(first_result->>'order_id')::uuid);
   if scenario='refund' then
    perform public.apply_commerce_refund(provider_name,sub_id||'-first',provider_name||'-recovery-account',sub_id||'-refund',1000);
   else
    perform public.apply_commerce_dispute_guarded(provider_name,sub_id||'-first',provider_name||'-recovery-account',sub_id||'-dispute','dispute-'||sub_id,'lost',1000);
   end if;
   next_result:=pg_temp.fulfill_subscription_test(session_id,sub_id||'-next',sub_id);
   perform public.apply_commerce_subscription_lifecycle_funded(provider_name,provider_name||'-recovery-account',sub_id,'renewed',sub_id||'-paid-next',now()-interval '1 day',now()+interval '1 month',p_funding_order_id=>(next_result->>'order_id')::uuid);
   if (select sales_count from public.commerce_products p where p.id=product_id)<>1
    or (select count(*) from public.commerce_access_grants g where g.product_id=(first_result->>'product_id')::uuid)<>1
    or (select token_hash from public.commerce_access_grants g where g.id=grant_id)<>sub_id||'-token'
    or (select g.status from public.commerce_access_grants g where g.id=grant_id)<>'active' then
    raise exception '% %: verified recovery lost durable access or consumed another seat',provider_name,scenario;
   end if;
  end loop;
 end loop;
end;
$$;

create function pg_temp.expect_funding_rejection(p_provider text,p_account text,p_sub text,p_order uuid,p_start timestamptz,p_end timestamptz,p_expected text)
returns void language plpgsql as $$
begin
 begin
  perform public.apply_commerce_subscription_lifecycle_funded(p_provider,p_account,p_sub,'renewed','rejected-'||gen_random_uuid(),p_start,p_end,p_funding_order_id=>p_order);
 exception when others then
  if position(p_expected in sqlerrm)=0 then raise exception 'Expected %, received %',p_expected,sqlerrm; end if;
  return;
 end;
 raise exception 'Expected funding rejection: %',p_expected;
end;
$$;

-- Exact immutable checkout identity, monotonic paid periods, and financially
-- safe restoration are enforced for each native provider, not event metadata.
do $$
declare owner_id uuid:=gen_random_uuid(); account_id uuid; offer_id uuid; other_offer uuid; session_id uuid; other_session uuid;
 provider_name text; sub_id text; first_result jsonb; current_result jsonb; late_result jsonb; other_result jsonb;
 root_grant uuid; r jsonb; p_start timestamptz:=now()-interval '1 day'; p_end timestamptz:=now()+interval '1 month';
begin
 insert into auth.users(id,email) values(owner_id,'invariants-'||owner_id||'@example.test');
 foreach provider_name in array array['stripe','paypal','razorpay','dodo','creem','polar'] loop
  sub_id:=provider_name||'-invariants';
  insert into public.creator_payment_accounts(creator_id,provider,provider_account_id) values(owner_id,provider_name,'invariant-account') returning id into account_id;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
  values(owner_id,'membership','published','scope-'||gen_random_uuid(),'scope-'||gen_random_uuid(),'Membership','subscription',1000,'usd','month') returning id into offer_id;
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
  values(offer_id,owner_id,account_id,provider_name,sub_id,'buyer@example.test',1000,0,0,'usd',sub_id||'-token') returning id into session_id;
  first_result:=pg_temp.fulfill_subscription_test(session_id,sub_id||'-first',sub_id);
  select id into strict root_grant from public.commerce_access_grants where order_id=(first_result->>'order_id')::uuid;
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'invariant-account',sub_id,'renewed',sub_id||'-initial',p_start-interval '1 month',p_start,p_funding_order_id=>(first_result->>'order_id')::uuid);
  current_result:=pg_temp.fulfill_subscription_test(session_id,sub_id||'-current',sub_id);
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'invariant-account',sub_id,'renewed',sub_id||'-current-paid',p_start,p_end,p_funding_order_id=>(current_result->>'order_id')::uuid);
  if (select funding_order_id from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id)<>(current_result->>'order_id')::uuid
    or (select order_id from public.commerce_access_grants where id=root_grant)<>(first_result->>'order_id')::uuid then raise exception 'Funding changed original grant identity'; end if;

  -- A newer-arriving old invoice must never become the current funding order.
  late_result:=pg_temp.fulfill_subscription_test(session_id,sub_id||'-late',sub_id);
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'invariant-account',sub_id,'renewed',sub_id||'-late-paid',p_start-interval '2 months',p_start-interval '1 month',p_funding_order_id=>(late_result->>'order_id')::uuid);
  perform public.apply_commerce_refund(provider_name,sub_id||'-late','invariant-account',sub_id||'-late-refund',1000,true,jsonb_build_object('funding_order_id',current_result->>'order_id','access_grant_id',root_grant));
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'invariant-account',sub_id,'active',sub_id||'-generic-active',p_start,p_end+interval '1 year',false,jsonb_build_object('funding_order_id',late_result->>'order_id'));
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'invariant-account',sub_id,'renewed',sub_id||'-unfunded-renewed',p_start,p_end+interval '1 year');
  if (select current_period_end from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id)<>p_end
    or (select funding_order_id from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id)<>(current_result->>'order_id')::uuid
    or (select status from public.commerce_access_grants where id=root_grant)<>'active' then raise exception 'Old invoice or status event changed funding'; end if;

  perform pg_temp.expect_funding_rejection(provider_name,'wrong-account',sub_id,(current_result->>'order_id')::uuid,p_start,p_end,'does not match');
  perform pg_temp.expect_funding_rejection(provider_name,'invariant-account','wrong-subscription',(current_result->>'order_id')::uuid,p_start,p_end,'does not match');
  perform pg_temp.expect_funding_rejection(provider_name,'invariant-account',sub_id,(current_result->>'order_id')::uuid,p_start,p_end+interval '1 second','immutable');

  -- Another genuinely paid buyer cannot fund this buyer's existing entitlement.
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
  values(offer_id,owner_id,account_id,provider_name,sub_id||'-other','other@example.test',1000,0,0,'usd',sub_id||'-other-token') returning id into other_session;
  other_result:=pg_temp.fulfill_subscription_test(other_session,sub_id||'-other-payment',sub_id||'-other');
  update public.commerce_orders set provider_subscription_id=sub_id where id=(other_result->>'order_id')::uuid;
  perform pg_temp.expect_funding_rejection(provider_name,'invariant-account',sub_id,(other_result->>'order_id')::uuid,p_start,p_end+interval '1 month','does not match');
  update public.commerce_orders set provider_subscription_id=sub_id||'-other' where id=(other_result->>'order_id')::uuid;

  -- Nor can a different product/session, even for the same buyer and account.
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
  values(owner_id,'membership','published','other-'||gen_random_uuid(),'other-'||gen_random_uuid(),'Other','subscription',1000,'usd','month') returning id into other_offer;
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
  values(other_offer,owner_id,account_id,provider_name,sub_id||'-product','buyer@example.test',1000,0,0,'usd',sub_id||'-product-token') returning id into other_session;
  other_result:=pg_temp.fulfill_subscription_test(other_session,sub_id||'-product-payment',sub_id||'-product');
  update public.commerce_orders set provider_subscription_id=sub_id where id=(other_result->>'order_id')::uuid;
  perform pg_temp.expect_funding_rejection(provider_name,'invariant-account',sub_id,(other_result->>'order_id')::uuid,p_start,p_end+interval '1 month','does not match');

  -- Financial events also enforce account identity. A forged metadata grant or
  -- funding pointer cannot change the already verified binding.
  r:=public.apply_commerce_refund(provider_name,sub_id||'-current','wrong-account',sub_id||'-wrong-account-refund',1000);
  if r is not null or (select status from public.commerce_access_grants where id=root_grant)<>'active' then raise exception 'Financial account scope was bypassed'; end if;
  perform public.apply_commerce_dispute_guarded(provider_name,sub_id||'-current','invariant-account',sub_id||'-disputed','dispute-'||sub_id,'lost',1000);
  r:=public.apply_commerce_subscription_lifecycle_funded(provider_name,'invariant-account',sub_id,'active',sub_id||'-after-dispute',p_start,p_end+interval '1 year');
  if r->>'reason'<>'financial_access_revoked' or (select status from public.commerce_access_grants where id=root_grant)<>'revoked' then raise exception 'Unverified status restored disputed access'; end if;
  perform public.apply_commerce_dispute_guarded(provider_name,sub_id||'-late','invariant-account',sub_id||'-old-won','old-dispute-'||sub_id,'won',1000);
  if (select status from public.commerce_access_grants where id=root_grant)<>'revoked' then raise exception 'Old favorable event restored current dispute'; end if;
  perform public.apply_commerce_dispute_guarded(provider_name,sub_id||'-current','invariant-account',sub_id||'-mismatched-won','wrong-dispute-'||sub_id,'won',1000);
  if (select status from public.commerce_access_grants where id=root_grant)<>'revoked' then raise exception 'Mismatched dispute restored access'; end if;
  perform public.apply_commerce_refund(provider_name,sub_id||'-current','invariant-account',sub_id||'-full-refund',1000);
  perform public.apply_commerce_dispute_guarded(provider_name,sub_id||'-current','invariant-account',sub_id||'-same-won','dispute-'||sub_id,'won',1000);
  if (select status from public.commerce_access_grants where id=root_grant)<>'revoked' then raise exception 'Favorable dispute restored fully refunded access'; end if;
 end loop;
end;
$$;

-- A defaulted final argument leaves exactly one PostgREST RPC candidate and
-- retains old ten-argument call compatibility without granting client execution.
do $$
begin
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='apply_commerce_subscription_lifecycle_funded')<>1 then raise exception 'Ambiguous lifecycle overload'; end if;
 if to_regprocedure('public.fulfill_provider_commerce_order(uuid,text,text,text,text,text,text,text,integer,integer,integer,integer,integer,integer,text,jsonb,text)') is null
 or to_regprocedure('public.apply_commerce_subscription_lifecycle(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer)') is null
 or to_regprocedure('public.apply_commerce_subscription_lifecycle_guarded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer)') is null then raise exception 'Legacy RPC signature removed'; end if;
 perform public.apply_commerce_subscription_lifecycle('stripe','legacy-account','unknown-subscription','active','legacy-base',null,null,false,'{}',3);
 perform public.apply_commerce_subscription_lifecycle_guarded('stripe','legacy-account','unknown-subscription','active','legacy-guarded',null,null,false,'{}',3);
 if has_function_privilege('anon','public.apply_commerce_subscription_lifecycle_funded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer,uuid)','execute')
 or has_function_privilege('authenticated','public.commerce_order_funds_access(uuid,uuid)','execute')
 or has_function_privilege('authenticated','public.lock_commerce_order_subscription(text,text,text)','execute') then raise exception 'Funding RPC exposed to client roles'; end if;
end;
$$;

-- New adapters commit verified service dates and access in the financial RPC;
-- the original seventeen-argument entry point remains a compatible default.
do $$
declare owner_id uuid:=gen_random_uuid(); account_id uuid; offer_id uuid; session_id uuid;
 provider_name text; sub_id text; r jsonb; root_grant uuid; paid_start timestamptz:=now(); paid_end timestamptz:=now()+interval '1 month'; rejected boolean;
begin
 insert into auth.users(id,email) values(owner_id,'atomic-'||owner_id||'@example.test');
 foreach provider_name in array array['stripe','paypal','razorpay','dodo','creem','polar'] loop
  sub_id:=provider_name||'-atomic';
  insert into public.creator_payment_accounts(creator_id,provider,provider_account_id) values(owner_id,provider_name,'atomic-account') returning id into account_id;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
  values(owner_id,'membership','published','atomic-'||gen_random_uuid(),'atomic-'||gen_random_uuid(),'Membership','subscription',1000,'usd','month') returning id into offer_id;
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
  values(offer_id,owner_id,account_id,provider_name,sub_id,'buyer@example.test',1000,0,0,'usd',sub_id||'-token') returning id into session_id;
  rejected:=false;
  begin
   perform public.fulfill_provider_commerce_order_with_period(offer_id,'buyer@example.test','Buyer',provider_name,'atomic-account',sub_id,sub_id||'-missing-end',sub_id,
     1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',session_id),sub_id||'-token',paid_start,null);
  exception when others then
   if position('complete verified service period' in sqlerrm)=0 then raise; end if;
   rejected:=true;
  end;
  if not rejected or exists(select 1 from public.commerce_orders where provider=provider_name and provider_payment_id=sub_id||'-missing-end') then raise exception 'Incomplete period created financial access'; end if;
  r:=public.fulfill_provider_commerce_order_with_period(offer_id,'buyer@example.test','Buyer',provider_name,'atomic-account',sub_id,sub_id||'-payment',sub_id,
    1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',session_id),sub_id||'-token',paid_start,paid_end);
  select id into strict root_grant from public.commerce_access_grants where order_id=(r->>'order_id')::uuid;
  if not exists(select 1 from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id
    and funding_order_id=(r->>'order_id')::uuid and current_period_start=paid_start and current_period_end=paid_end)
    or (select expires_at from public.commerce_access_grants where id=root_grant) is null
    or (select status from public.commerce_access_grants where id=root_grant)<>'active' then raise exception 'Financial RPC returned before funded access was bounded'; end if;
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'atomic-account',sub_id,'cancel_at_period_end',sub_id||'-cancel',null,paid_end,true);
  -- Idempotent capture replay must not overwrite a later cancellation snapshot.
  perform public.apply_commerce_subscription_lifecycle_funded(provider_name,'atomic-account',sub_id,'renewed',sub_id||'-paid-webhook-retry',paid_start,paid_end,p_funding_order_id=>(r->>'order_id')::uuid);
  if not exists(select 1 from public.commerce_subscription_access access join public.commerce_access_grants grant_row on grant_row.id=access.access_grant_id where access.provider=provider_name and access.provider_subscription_id=sub_id and access.status='cancel_at_period_end' and grant_row.expires_at=paid_end) then raise exception 'Funded paid replay reset cancellation or its paid deadline'; end if;
  r:=public.fulfill_provider_commerce_order_with_period(offer_id,'buyer@example.test','Buyer',provider_name,'atomic-account',sub_id,sub_id||'-payment',sub_id,
    1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',session_id),sub_id||'-token',paid_start,paid_end);
  if not (r->>'already_processed')::boolean or (select expires_at from public.commerce_access_grants where id=root_grant)<>paid_end then raise exception 'Capture replay reset cancellation deadline'; end if;
 end loop;
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='fulfill_provider_commerce_order_with_period')<>1 then raise exception 'Ambiguous financial RPC overload'; end if;
end;
$$;

-- Null and empty account identifiers address the same subscription snapshot.
do $$
declare u uuid:=gen_random_uuid(); a uuid; p uuid; s uuid; r jsonb;
begin
 insert into auth.users(id,email) values(u,'null-account-'||u||'@example.test');
 insert into public.creator_payment_accounts(creator_id,provider,provider_account_id) values(u,'stripe','') returning id into a;
 insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
 values(u,'membership','published','null-'||u,'null-'||u,'Membership','subscription',1000,'usd','month') returning id into p;
 insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
 values(p,u,a,'stripe','null-account-sub','buyer@example.test',1000,0,0,'usd','null-account-'||u) returning id into s;
 r:=public.fulfill_provider_commerce_order_with_period(p,'buyer@example.test','Buyer','stripe','','null-account-sub','null-account-payment','null-account-sub',1000,0,0,0,0,1000,'usd',jsonb_build_object('bento_session_id',s),'null-account-'||u,now(),now()+interval '1 month');
 perform public.apply_commerce_subscription_lifecycle_funded('stripe',null,'null-account-sub','active','null-account-status',null,now()+interval '1 year');
 if (select count(*) from public.commerce_subscription_access where provider='stripe' and provider_subscription_id='null-account-sub')<>1
 or not exists(select 1 from public.commerce_subscription_access where provider='stripe' and provider_account_id='' and provider_subscription_id='null-account-sub' and funding_order_id=(r->>'order_id')::uuid and current_period_end=now()+interval '1 month') then
  raise exception 'Null provider account forked or extended the paid snapshot';
 end if;
end;
$$;

-- Old workers must record a real payment before their ten-argument lifecycle
-- call can advance a funded period. Generic snapshots and replay cannot do so.
do $$
declare u uuid:=gen_random_uuid(); a uuid; p uuid; s uuid; initial_order jsonb; renewal_order jsonb; ambiguous_order jsonb;
 provider_name text; sub_id text; period_start timestamptz:=now()-interval '1 day'; period_end timestamptz:=now()+interval '1 month'; rejected boolean;
begin
 insert into auth.users(id,email) values(u,'legacy-bridge-'||u||'@example.test');
 foreach provider_name in array array['stripe','paypal','razorpay','dodo','creem','polar'] loop
  sub_id:='legacy-bridge-'||provider_name||'-'||u;
  insert into public.creator_payment_accounts(creator_id,provider,provider_account_id) values(u,provider_name,'legacy-account') returning id into a;
  insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
  values(u,'membership','published',sub_id,sub_id,'Legacy membership','subscription',1000,'usd','month') returning id into p;
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
  values(p,u,a,provider_name,sub_id,'buyer@example.test',1000,0,0,'usd',sub_id) returning id into s;
  initial_order:=pg_temp.fulfill_subscription_test(s,sub_id||'-first',sub_id);
  perform public.apply_commerce_subscription_lifecycle(provider_name,'legacy-account',sub_id,'active',sub_id||'-initial',period_start-interval '1 month',period_start,false,'{}',3);
  if not exists(select 1 from public.commerce_subscription_access access join public.commerce_access_grants grant_row on grant_row.id=access.access_grant_id where access.provider=provider_name and access.provider_subscription_id=sub_id and access.current_period_end=period_start and grant_row.expires_at=period_start+interval '3 days') then raise exception 'Legacy initial active did not preserve bounded paid access'; end if;
  renewal_order:=pg_temp.fulfill_subscription_test(s,sub_id||'-renewal',sub_id,jsonb_build_object('metadata',jsonb_build_object('stripe_invoice_id',sub_id||'-renewal','current_period_start',period_start,'current_period_end',period_end)));
  perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'active',sub_id||'-snapshot',period_start,period_end,false,'{}',3);
  if (select current_period_end from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id)<>period_start then raise exception 'Legacy generic snapshot advanced funding'; end if;
  rejected:=false;
  begin
   perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'renewed',sub_id||'-generic-renewed',period_end,period_end+interval '1 month',false,'{}',3);
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'Legacy status consumed an uncorrelated payment for an unearned period'; end if;
  if (select subscription_period_end from public.commerce_orders where id=(renewal_order->>'order_id')::uuid) is not null then raise exception 'Rejected legacy status consumed the pending paid proof'; end if;
  perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'renewed',case when provider_name='razorpay' then 'payment:'||sub_id||'-renewal:paid' else sub_id||'-renewed' end,period_start,period_end,false,jsonb_build_object('stripe_invoice_id',sub_id||'-renewal','dodo_payment_id',sub_id||'-renewal','polar_order_id',sub_id||'-renewal'),3);
  if not exists(select 1 from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id and funding_order_id=(renewal_order->>'order_id')::uuid and current_period_end=period_end) then raise exception 'Legacy paid renewal did not advance funded period'; end if;
  perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'cancel_at_period_end',sub_id||'-cancel',period_start,period_end,true,'{}',3);
  perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'renewed',sub_id||'-same-period-retry',period_start,period_end,false,'{}',3);
  if not exists(select 1 from public.commerce_subscription_access access join public.commerce_access_grants grant_row on grant_row.id=access.access_grant_id where access.provider=provider_name and access.provider_subscription_id=sub_id and access.status='cancel_at_period_end' and grant_row.expires_at=period_end) then raise exception 'Legacy paid replay reset cancellation or its paid deadline'; end if;
  rejected:=false;
  begin
   perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'renewed',sub_id||'-replay-future',period_end,period_end+interval '1 month',false,'{}',3);
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'Legacy replay acknowledged new period without a new paid order'; end if;
  renewal_order:=pg_temp.fulfill_subscription_test(s,sub_id||'-ambiguous-1',sub_id,jsonb_build_object('metadata',jsonb_build_object('stripe_invoice_id','ambiguous','current_period_start',period_end,'current_period_end',period_end+interval '1 month')));
  ambiguous_order:=pg_temp.fulfill_subscription_test(s,sub_id||'-ambiguous-2',sub_id,jsonb_build_object('metadata',jsonb_build_object('stripe_invoice_id','ambiguous','current_period_start',period_end,'current_period_end',period_end+interval '1 month')));
  rejected:=false;
  begin
   perform public.apply_commerce_subscription_lifecycle_guarded(provider_name,'legacy-account',sub_id,'renewed',sub_id||'-ambiguous',period_end,period_end+interval '1 month',false,jsonb_build_object('stripe_invoice_id','ambiguous'),3);
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'Legacy renewal chose an ambiguous unregistered payment'; end if;
  if (select current_period_end from public.commerce_subscription_access where provider=provider_name and provider_subscription_id=sub_id)<>period_end then raise exception 'Rejected legacy funding changed access'; end if;
 end loop;
end; $$;

-- Simulate a funding registration that returns a safe rejection rather than an
-- exception. The financial RPC must not ignore it and commit unbounded access.
do $$ begin
 execute replace(pg_get_functiondef('public.apply_commerce_subscription_lifecycle_funded(text,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,integer,uuid)'::regprocedure), 'public.apply_commerce_subscription_lifecycle_funded(', 'pg_temp.original_subscription_lifecycle_funded(');
end; $$;
create or replace function public.apply_commerce_subscription_lifecycle_funded(
 p_provider text,p_provider_account_id text,p_provider_subscription_id text,p_state text,p_provider_event_id text,
 p_current_period_start timestamptz default null,p_current_period_end timestamptz default null,
 p_cancel_at_period_end boolean default false,p_metadata jsonb default '{}',p_grace_days integer default 3,p_funding_order_id uuid default null
) returns jsonb language sql security definer set search_path='' as $$
 select case when p_provider_subscription_id='forced-funding-rejection'
 then jsonb_build_object('applied',false,'reason','test_rejected_funding')
 else pg_temp.original_subscription_lifecycle_funded(p_provider,p_provider_account_id,p_provider_subscription_id,p_state,p_provider_event_id,
  p_current_period_start,p_current_period_end,p_cancel_at_period_end,p_metadata,p_grace_days,p_funding_order_id) end;
$$;
do $$
declare owner_id uuid:=gen_random_uuid(); account_id uuid; offer_id uuid; session_id uuid; amount integer; sub_id text; rejected boolean;
begin
 insert into auth.users(id,email) values(owner_id,'reject-'||owner_id||'@example.test');
 insert into public.creator_payment_accounts(creator_id,provider,provider_account_id) values(owner_id,'stripe','rejected-account') returning id into account_id;
 insert into public.commerce_products(creator_id,kind,status,slug,public_slug,title,pricing_type,price_amount,currency,billing_interval)
 values(owner_id,'membership','published','rejected-'||gen_random_uuid(),'rejected-'||gen_random_uuid(),'Membership','subscription',1000,'usd','month') returning id into offer_id;
 foreach amount in array array[0,1000] loop
  sub_id:=case when amount=0 then 'zero-native-period' else 'forced-funding-rejection' end;
  insert into public.commerce_payment_sessions(product_id,creator_id,connection_id,provider,provider_checkout_id,buyer_email,gross_amount,platform_fee_bps,platform_fee_amount,currency,access_token_hash)
  values(offer_id,owner_id,account_id,'stripe',sub_id,'buyer@example.test',amount,0,0,'usd',sub_id||'-token') returning id into session_id;
  rejected:=false;
  begin
   perform public.fulfill_provider_commerce_order_with_period(offer_id,'buyer@example.test','Buyer','stripe','rejected-account',sub_id,sub_id||'-payment',sub_id,
    amount,0,0,0,0,amount,'usd',jsonb_build_object('bento_session_id',session_id),sub_id||'-token',now(),now()+interval '1 month');
  exception when others then
   if position('verified service period' in sqlerrm)=0 and position('Funding period was not committed' in sqlerrm)=0 then raise; end if;
   rejected:=true;
  end;
  if not rejected or exists(select 1 from public.commerce_orders where provider='stripe' and provider_payment_id=sub_id||'-payment')
   or exists(select 1 from public.commerce_access_grants where token_hash=sub_id||'-token') then
   raise exception 'Rejected native funding committed an order or unbounded active grant';
  end if;
 end loop;
end;
$$;

rollback;
