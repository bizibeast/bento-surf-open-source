"""Offline PostgreSQL checks for private reference jobs; no hosted credentials."""
import concurrent.futures
from pathlib import Path
import subprocess
import time
import uuid

root = Path(__file__).resolve().parent.parent
name = 'bento-reference-test-' + uuid.uuid4().hex[:10]
owner = '11111111-1111-4111-8111-111111111111'
other = '22222222-2222-4222-8222-222222222222'

def sql(query):
    return subprocess.check_output(['docker', 'exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input=query, text=True)

try:
    subprocess.run(['docker', 'run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=local-test-only', 'postgres:17'], check=True, stdout=subprocess.DEVNULL)
    for _ in range(100):
        if subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.2)
    sql(f"""create role anon; create role authenticated; create role service_role;
create schema auth; create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key,workspace_status text);
create table public.workspace_memberships(workspace_id uuid,auth_user_id uuid,role text,status text);
insert into auth.users values('{owner}'),('{other}');
insert into profiles values('{owner}','active'),('{other}','active');
insert into workspace_memberships values('{owner}','{owner}','owner','active'),('{other}','{other}','owner','active');
""")
    sql((root / 'supabase/migrations/20261119195822_content_reference_analysis.sql').read_text())
    def queue(request, actor=owner, workspace=owner, payload='{}'):
        return sql(f"select public.queue_content_reference('{workspace}','{actor}','{request}','{payload}'::jsonb)").strip()
    assert queue(uuid.uuid4(), other) == '', 'cross-tenant queue allowed'
    request = uuid.uuid4()
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as pool:
        results = list(pool.map(lambda _: queue(request), range(30)))
    assert len(set(results)) == 1 and results[0], results
    assert queue(request, payload='{"changed":true}') == '', 'changed idempotency input allowed'
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as pool:
        results = list(pool.map(lambda _: queue(uuid.uuid4()), range(20)))
    assert results == [''] * 20, 'parallel active jobs allowed'
    sql("update content_reference_jobs set status='failed'")
    for _ in range(4):
        assert queue(uuid.uuid4()), 'daily cap prematurely blocked'
        sql("update content_reference_jobs set status='failed'")
    assert queue(uuid.uuid4()) == '', 'sixth daily job allowed'
    assert queue(request), 'idempotent receipt blocked at daily cap'
    sql("update content_reference_jobs set status='ready'")
    job = queue(request)
    draft_request = uuid.uuid4()
    def draft():
        return sql(f"select claim_content_reference_draft('{owner}','{owner}','{draft_request}','{job}','{{}}')").strip()
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as pool:
        results = list(pool.map(lambda _: draft(), range(30)))
    assert sum(bool(item) for item in results) == 1, results
    assert sql(f"select claim_content_reference_draft('{other}','{other}','{uuid.uuid4()}','{job}','{{}}')").strip() == '', 'foreign analysis used'
    sql("update content_reference_jobs set expires_at=now()-interval '1 second'")
    assert sql(f"select claim_content_reference_draft('{owner}','{owner}','{uuid.uuid4()}','{job}','{{}}')").strip() == '', 'expired evidence used'
    # The analysis can age out before drafts based on it. Retention follows the child's date.
    editable_job = uuid.uuid4()
    sql(f"""
update content_reference_jobs set created_at=now()-interval '37 days',cleaned_at=now() where id='{job}';
update content_reference_drafts set created_at=now()-interval '36 days';
insert into content_reference_drafts(workspace_id,auth_user_id,request_id,analysis_id,input,created_at)
select '{owner}','{owner}',gen_random_uuid(),'{job}','{{}}',date_trunc('month',now() at time zone 'UTC') at time zone 'UTC'
from generate_series(1,30);
insert into content_reference_jobs(id,workspace_id,auth_user_id,request_id,input,status)
values ('{editable_job}','{owner}','{owner}',gen_random_uuid(),'{{}}','ready');
select purge_content_reference_receipts();
""")
    assert sql(f"select count(*) from content_reference_drafts where analysis_id='{job}'").strip() == '30', 'current-month receipts lost with old parent'
    assert sql(f"select count(*) from content_reference_jobs where id='{job}'").strip() == '1', 'analysis deleted while retained drafts reference it'
    assert sql(f"select claim_content_reference_draft('{owner}','{owner}','{uuid.uuid4()}','{editable_job}','{{}}')").strip() == '', 'purge reopened the current-month draft cap'
    sql(f"begin; delete from public.profiles where id='{owner}'; rollback;")
    sql(f"update content_reference_drafts set created_at=now()-interval '36 days' where analysis_id='{job}'; select purge_content_reference_receipts();")
    assert sql(f"select count(*) from content_reference_jobs where id='{job}'").strip() == '0', 'old parent did not purge after drafts aged out'
    sql(f"""do $$begin
if has_table_privilege('anon','public.content_reference_jobs','select') or has_table_privilege('authenticated','public.content_reference_drafts','insert') then raise exception 'untrusted table grant'; end if;
if has_function_privilege('authenticated','public.queue_content_reference(uuid,uuid,uuid,jsonb)','execute') or has_function_privilege('anon','public.claim_content_reference_draft(uuid,uuid,uuid,uuid,jsonb)','execute') then raise exception 'untrusted RPC grant'; end if;
if has_function_privilege('authenticated','public.purge_content_reference_receipts()','execute') or not has_function_privilege('service_role','public.purge_content_reference_receipts()','execute') then raise exception 'invalid receipt purge grant'; end if;
if not has_table_privilege('service_role','public.content_reference_jobs','update') then raise exception 'service role denied'; end if;
if not (select relrowsecurity from pg_class where oid='public.content_reference_jobs'::regclass) then raise exception 'RLS missing'; end if;
end $$;
insert into content_reference_jobs(workspace_id,auth_user_id,request_id,input,status,created_at)
select '{other}','{other}',gen_random_uuid(),'{{}}','failed',date_trunc('month',now()) from generate_series(1,30);
""")
    assert queue(uuid.uuid4(), other, other) == '', 'monthly cap allowed'
    # Same global lock coordinates independent creators, so a global cap cannot be raced.
    sql(f"""insert into content_reference_jobs(workspace_id,auth_user_id,request_id,input,status)
select '{owner}','{owner}',gen_random_uuid(),'{{}}','failed' from generate_series(1,100);
""")
    third = '33333333-3333-4333-8333-333333333333'
    sql(f"insert into auth.users values('{third}'); insert into profiles values('{third}','active'); insert into workspace_memberships values('{third}','{third}','owner','active');")
    assert queue(uuid.uuid4(), third, third) == '', 'global daily cap allowed'
    print('PASS: concurrent claims; daily/monthly/global caps; tenant/expiry/RLS/grants; idempotency; per-draft retention and post-purge monthly accounting.')
finally:
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
