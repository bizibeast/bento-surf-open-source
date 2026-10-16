"""Run budget SQL and concurrency checks in a disposable local PostgreSQL container.
Requires Docker and Python 3. Never uses a hosted database or application credentials.
"""
import concurrent.futures
from pathlib import Path
import subprocess
import time
import uuid

root = Path(__file__).resolve().parent.parent
name = 'bento-cost-test-' + uuid.uuid4().hex[:10]

def sql(query):
    return subprocess.check_output(['docker', 'exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input=query, text=True)

try:
    subprocess.run(['docker', 'run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=local-test-only', 'postgres:17'], check=True, stdout=subprocess.DEVNULL)
    for attempt in range(100):
        if subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.2)
    sql('''create role anon; create role authenticated; create role service_role;
create table public.creator_content_index_jobs(user_id uuid primary key,status text,lease_id uuid,lease_expires_at timestamptz,attempts integer,next_attempt_at timestamptz);
create table public.social_analytics_snapshots(user_id uuid,refresh_job_id uuid,refresh_started_at timestamptz);
create table public.social_mention_search_cache(expires_at timestamptz);
create table public.social_preview_attempts(created_at timestamptz);
create table public.content_agent_threads(id uuid primary key);
create table public.content_agent_messages(id uuid primary key,thread_id uuid,payload jsonb);
create table public.creator_content_media(user_id uuid,lease_expires_at timestamptz);
''')
    sql((root / 'supabase/migrations/20261015210000_provider_cost_guardrails.sql').read_text())
    sql('''begin;
update public.provider_budget_policies set daily_limit=10,monthly_limit=12,workspace_daily_limit=4,workspace_monthly_limit=5 where resource='apimart_images';
do $$begin
 if public.reserve_provider_usage('missing',1,null) then raise exception 'missing policy allowed'; end if;
 if public.reserve_provider_usage('apimart_images',0,null) then raise exception 'zero allowed'; end if;
 if public.reserve_provider_usage('x_read_units',1,null) then raise exception 'disabled allowed'; end if;
 if not public.reserve_provider_usage('apimart_images',4,'11111111-1111-4111-8111-111111111111') then raise exception 'first reservation denied'; end if;
 if public.reserve_provider_usage('apimart_images',1,'11111111-1111-4111-8111-111111111111') then raise exception 'workspace overrun'; end if;
 if not public.reserve_provider_usage('apimart_images',4,'22222222-2222-4222-8222-222222222222') then raise exception 'second workspace denied'; end if;
 if public.reserve_provider_usage('apimart_images',3,null) then raise exception 'global overrun'; end if;
 if not public.reserve_provider_usage('apimart_images',2,null) then raise exception 'global boundary denied'; end if;
 if (select units from public.provider_budget_usage where resource='apimart_images' and scope='global' and period_kind='day')<>10 then raise exception 'rejection mutated counters'; end if;
 if has_function_privilege('anon','public.reserve_provider_usage(text,bigint,uuid)','execute') or has_function_privilege('authenticated','public.reserve_provider_usage(text,bigint,uuid)','execute') then raise exception 'untrusted role allowed'; end if;
 if not has_function_privilege('service_role','public.reserve_provider_usage(text,bigint,uuid)','execute') then raise exception 'service role denied'; end if;
end $$;
insert into content_agent_threads(id) values ('11111111-1111-4111-8111-111111111111');
insert into content_agent_messages values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','{}');
update content_agent_messages set payload='{"updated":true}';
delete from content_agent_messages;
do $$begin
 if (select content_revision from content_agent_threads limit 1)<>3 then raise exception 'chat revision lost'; end if;
end $$;
select public.cleanup_provider_cost_data();
rollback;
update public.provider_budget_policies set daily_limit=10,monthly_limit=10,workspace_daily_limit=10,workspace_monthly_limit=10 where resource='apimart_images';
''')
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda _: sql("select public.reserve_provider_usage('apimart_images',1,null)").strip(), range(50)))
    assert results.count('t') == 10 and results.count('f') == 40, results
    print('PASS: fail-closed policies, workspace/global boundaries, access grants, chat revisions, cleanup, and 50 concurrent reservations (10 accepted, 40 blocked).')
finally:
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
