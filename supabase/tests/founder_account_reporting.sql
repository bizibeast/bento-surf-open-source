-- Run with psql -v ON_ERROR_STOP=1 in an EMPTY disposable local database.
-- Synthetic fixtures only; all schema and data changes roll back.
begin;
create schema auth;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table auth.users(id uuid primary key, email text, last_sign_in_at timestamptz);
create table public.profiles(id uuid primary key, username text, display_name text, is_pro boolean default false, onboarded boolean default false, plan_id text, created_at timestamptz, updated_at timestamptz);
create table public.subscriptions(id uuid primary key, user_id uuid, amount bigint, currency text, billing_interval text, status text, plan_id text, updated_at timestamptz, created_at timestamptz);
create table public.payments(user_id uuid, currency text, total_amount bigint, status text, occurred_at timestamptz, created_at timestamptz);
create table public.refunds(user_id uuid, currency text, amount bigint, status text, occurred_at timestamptz, created_at timestamptz);
create table public.blocks(user_id uuid, updated_at timestamptz);
create table public.pages(user_id uuid, updated_at timestamptz);
create table public.analytics_daily(user_id uuid, day date, views integer);
create table public.instagram_dm_automations(enabled boolean);
create table public.instagram_dm_runs(status text, created_at timestamptz);
create table public.founder_brain_daily_usage(user_id uuid, day date);
create table public.creator_brain_items(user_id uuid, status text, updated_at timestamptz);
create table public.content_agent_messages(user_id uuid, role text, created_at timestamptz);
create table public.content_routine_runs(user_id uuid, status text, created_at timestamptz);
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','founder@example.test');
insert into public.profiles values ('00000000-0000-4000-8000-000000000001','founder','Founder',true,true,'creator_plus','2026-10-22T03:00:00Z','2026-10-22T03:00:00Z');
insert into public.subscriptions values
 ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001',1000,'USD','month','active','store','2026-10-22Z','2026-10-22Z'),
 ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',3000,'USD','month','trialing','creator_plus','2026-10-22Z','2026-10-22Z');
insert into public.payments values ('00000000-0000-4000-8000-000000000001','USD',1000,'succeeded','2026-10-22T01:00:00Z','2026-10-22T01:00:00Z');
insert into public.refunds values ('00000000-0000-4000-8000-000000000001','USD',200,'succeeded','2026-10-22T02:00:00Z','2026-10-22T02:00:00Z');
insert into public.instagram_dm_runs select case when n % 2 = 0 then 'failed' else 'completed' end, now() from generate_series(1,120) n;
insert into public.instagram_dm_automations values(true),(false),(true);
insert into public.founder_brain_daily_usage values ('00000000-0000-4000-8000-000000000001','2026-10-22');
grant usage on schema public,auth to service_role;
grant select on all tables in schema public,auth to service_role;


alter table auth.users add column created_at timestamptz not null default now();
update auth.users set created_at='2026-10-01T03:00:00Z';
update public.profiles set is_pro=false,onboarded=false,plan_id='free',created_at='2026-10-01T03:00:00Z';
truncate public.subscriptions,public.payments,public.refunds,public.blocks;
create table public.workspace_memberships(auth_user_id uuid references auth.users(id) on delete cascade,workspace_id uuid references public.profiles(id) on delete cascade,role text,status text,primary key(auth_user_id,workspace_id));
insert into auth.users(id,email,created_at) values ('00000000-0000-4000-8000-000000000002','new@example.test','2026-10-22T03:00:00Z');
insert into public.profiles values
 ('00000000-0000-4000-8000-000000000002','new','New',false,false,'free','2026-10-22T03:00:00Z','2026-10-22T03:00:00Z'),
 ('00000000-0000-4000-8000-000000000003','extra_one','Extra one',true,true,'store','2026-10-20T03:00:00Z','2026-10-20T03:00:00Z'),
 ('00000000-0000-4000-8000-000000000004','extra_two','Extra two',true,true,'creator_plus','2026-10-21T03:00:00Z','2026-10-21T03:00:00Z');
insert into public.workspace_memberships values
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner','active'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','owner','active'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','owner','active'),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','owner','active');
insert into public.blocks values ('00000000-0000-4000-8000-000000000003',now()),('00000000-0000-4000-8000-000000000004',now());

-- Prove the pre-repair query is exercised by this fixture.
\ir ../migrations/20261022140911_founder_reporting_reliability.sql
do $$ declare d jsonb; begin
 d:=public.get_founder_dashboard_database('2026-10-16Z','2026-10-22T14:00:00Z',7);
 if (d->'totals'->>'newUsersPeriod')::int<>3 or (d->'totals'->>'onboarded')::int<>2 then raise exception 'Fixture does not reproduce the account/workspace mismatch'; end if;
end $$;
\ir ../migrations/20261022155059_founder_account_workspace_metrics.sql
do $$
declare d jsonb; rows_count int; daily_total int; activated_row jsonb;
begin
 d:=public.get_founder_dashboard_database('2026-10-16Z','2026-10-22T14:00:00Z',7);
 if (d->'totals'->>'users')::int<>2 or (d->'totals'->>'workspaces')::int<>4 then raise exception 'Account/workspace totals mixed'; end if;
 if (d->'totals'->>'newUsersPeriod')::int<>1 then raise exception 'Extra workspace counted as signup'; end if;
 if (d->'totals'->>'onboarded')::int<>1 or (d->'totals'->>'pro')::int<>1 then raise exception 'Milestones not deduplicated across workspaces'; end if;
 select sum((value->>'signups')::int) into daily_total from jsonb_array_elements(d->'dailySignups');
 if daily_total<>1 or (d->'dailySignups'->6->>'signups')::int<>1 then raise exception 'Daily signups count workspace creation'; end if;
 if (d->'funnel'->0->>'value')::int<>2 or (d->'funnel'->1->>'value')::int<>1 or (d->'funnel'->2->>'value')::int<>1 or (d->'funnel'->3->>'value')::int<>1 then raise exception 'Account funnel mixed scopes'; end if;
 if (d->'totals'->>'free')::int<>2 or (d->'totals'->>'store')::int<>1 or (d->'totals'->>'creator_plus')::int<>1 then raise exception 'Workspace plan counts incorrectly deduplicated'; end if;
 if jsonb_array_length(d->'recentUsers')<>2 then raise exception 'Recent accounts multiplied by memberships'; end if;
 select value into activated_row from jsonb_array_elements(d->'recentUsers') where value->>'id'='00000000-0000-4000-8000-000000000001';
 if not (activated_row->>'onboarded')::boolean or (activated_row->>'createdAt')::timestamptz<>'2026-10-01T03:00:00Z'::timestamptz or activated_row->>'planId'<>'free' then raise exception 'Recent account identity/date or primary-workspace plan incorrect'; end if;
 if has_function_privilege('anon','public.get_founder_dashboard_database(timestamptz,timestamptz,integer)','execute') or has_function_privilege('authenticated','public.get_founder_dashboard_database(timestamptz,timestamptz,integer)','execute') then raise exception 'Founder RPC exposed'; end if;
 raise notice 'PASS: 2 accounts / 4 workspaces; extra workspace creation adds no signup, milestones deduplicate by owner, plan mix remains workspace scoped';
end $$;
-- Accounts remain visible when their original workspace is removed.
delete from public.profiles where id='00000000-0000-4000-8000-000000000001';
do $$ declare d jsonb; account_row jsonb; begin
 d:=public.get_founder_dashboard_database('2026-10-16Z','2026-10-22T14:00:00Z',7);
 select value into account_row from jsonb_array_elements(d->'recentUsers') where value->>'id'='00000000-0000-4000-8000-000000000001';
 if jsonb_array_length(d->'recentUsers')<>2 or account_row->>'username'<>'extra_one' or account_row->>'planId'<>'store' then raise exception 'Account lost after primary workspace removal'; end if;
 raise notice 'PASS: account retained after original workspace removal with oldest remaining owned workspace';
end $$;
rollback;
