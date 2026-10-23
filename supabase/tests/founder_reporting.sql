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

\ir ../migrations/20261022140911_founder_reporting_reliability.sql
do $$
declare d jsonb; previous jsonb; counts jsonb;
begin
 select public.get_founder_dashboard_database('2026-10-16T00:00:00Z','2026-10-22T14:00:00Z',7) into d;
 if jsonb_array_length(d->'dailySignups') <> 7 or d->'dailySignups'->6->>'date' <> '2026-10-22' then raise exception 'Today missing or incorrect date count: %',d->'dailySignups'; end if;
 if (d->'dailySignups'->6->>'signups')::int <> 1 then raise exception 'Today signup missing'; end if;
 if (d->'dailyRevenue'->6->>'revenue')::int <> 800 then raise exception 'Today payment/refund missing'; end if;
 if (d->'revenue'->0->>'mrr')::int <> 1000 then raise exception 'Trials counted in paid MRR'; end if;
 if (d->'totals'->>'creator_plus')::int <> 1 then raise exception 'Creator Plus miscounted'; end if;
 if jsonb_array_length(d->'recentUsers') <> 1 then raise exception 'Duplicate subscriptions duplicated user'; end if;
 if d->'recentUsers'->0->>'subscriptionStatus' <> 'trialing' then raise exception 'Highest plan was not selected'; end if;
 select public.get_founder_dashboard_database('2026-10-09Z','2026-10-16Z',7) into previous;
 if previous->'dailySignups'->6->>'date' <> '2026-10-15' then raise exception 'Previous period overlaps'; end if;
 select public.get_founder_operational_counts() into counts;
 if (counts->'runs24h'->>'total')::int <> 120 or (counts->'runs24h'->>'failed')::int <> 60 then raise exception 'Health counts truncated'; end if;
 if (public.get_founder_content_adoption('2026-10-16Z','2026-10-22T14:00:00Z')->>'brainVisitorsPeriod')::int <> 1 then raise exception 'Today Brain visit missing'; end if;
 if (public.get_founder_content_adoption('2026-10-15Z','2026-10-22T00:00:00Z')->>'brainVisitorsPeriod')::int <> 0 then raise exception 'Midnight boundary overlap'; end if;
 if has_function_privilege('anon','public.get_founder_dashboard_database(timestamptz,timestamptz,integer)','EXECUTE') or has_function_privilege('authenticated','public.get_founder_operational_counts()','EXECUTE') or has_function_privilege('authenticated','public.get_founder_content_adoption(timestamptz,timestamptz)','EXECUTE') then raise exception 'Founder function exposed'; end if;
 if not has_function_privilege('service_role','public.get_founder_operational_counts()','EXECUTE') then raise exception 'Service role cannot query'; end if;
 raise notice 'PASS: founder date boundaries, trial exclusion, exact >50 counts, highest-plan deduplication, Creator Plus, Brain visits, and restricted RPC privileges';
end $$;
set timezone='Asia/Kolkata';
do $$ declare d jsonb; begin select public.get_founder_dashboard_database('2026-10-16T00:00:00Z','2026-10-22T14:00:00Z',7) into d; if (d->'dailyRevenue'->6->>'revenue')::int <> 800 or (d->'dailySignups'->6->>'signups')::int <> 1 then raise exception 'Session timezone changes UTC bucket'; end if; raise notice 'PASS: report dates independent of session timezone'; end $$;

rollback;
