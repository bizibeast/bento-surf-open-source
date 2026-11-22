"""Exercise weekly aggregates in a disposable PostgreSQL 17 database.

Uses no hosted data or credentials. Set BENTO_POSTGRES_BIN when the PostgreSQL
tools are not on PATH (Homebrew's postgresql@17 is detected automatically).
"""
import json
import glob
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
configured = os.environ.get("BENTO_POSTGRES_BIN")
candidates = [shutil.which("initdb"), *sorted(glob.glob("/usr/lib/postgresql/*/bin/initdb")), "/opt/homebrew/opt/postgresql@17/bin/initdb"]
pgbin = Path(configured) if configured else next((Path(path).parent for path in candidates if path and Path(path).is_file()), Path("/nonexistent"))
if not (pgbin / "initdb").is_file():
    raise SystemExit("PostgreSQL tools are required; set BENTO_POSTGRES_BIN.")

with tempfile.TemporaryDirectory(prefix="bento-home-pulse-") as temporary:
    directory = Path(temporary)
    database = directory / "data"
    subprocess.run([str(pgbin / "initdb"), "-D", str(database), "-U", "postgres", "-A", "trust", "--no-locale"], check=True, stdout=subprocess.DEVNULL)
    started = False
    command = [str(pgbin / "psql"), "-h", temporary, "-p", "55449", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"]
    def sql(query):
        return subprocess.check_output(command, input=query, text=True, stderr=subprocess.PIPE).strip()
    try:
        subprocess.run([str(pgbin / "pg_ctl"), "-D", str(database), "-l", str(directory / "postgres.log"), "-o", f"-F -k {temporary} -h '' -p 55449", "-w", "start"], check=True, stdout=subprocess.DEVNULL)
        started = True
        sql("""
          create role anon; create role authenticated; create role service_role;
          create table public.instagram_dm_runs(user_id uuid, connection_id uuid,
            sender_id_hash text, follow_verified_at timestamptz,
            follow_recheck_count integer, follow_prompt_response_id text);
          create table public.audience_contacts(id integer primary key, creator_id uuid,
            first_seen_at timestamptz, first_source text);
          create table public.commerce_orders(creator_id uuid, currency text,
            gross_amount integer, refunded_amount integer, paid_at timestamptz,
            created_at timestamptz, status text);
          grant usage on schema public to service_role;
          grant select on all tables in schema public to service_role;
        """)
        migration = (root / "supabase/migrations/20261118120000_home_weekly_pulse.sql").read_text()
        sql(migration)
        sql(migration)  # Reapplication must not destroy or duplicate source records.
        owner = "10000000-0000-4000-8000-000000000001"
        other = "10000000-0000-4000-8000-000000000002"
        connection = "20000000-0000-4000-8000-000000000001"
        now = "2026-11-18T12:00:00Z"
        sql(f"""
          insert into public.instagram_dm_runs values
            ('{owner}','{connection}','same','2026-11-17T12:00Z',1,'prompt'),
            ('{owner}','{connection}','same','2026-11-17T13:00Z',2,'prompt'),
            ('{owner}','{connection}','edge','2026-11-11T12:00Z',1,'prompt'),
            ('{owner}','{connection}','previous','2026-11-10T12:00Z',1,'prompt'),
            ('{owner}','{connection}','boundary','2026-11-04T12:00Z',1,'prompt'),
            ('{owner}','{connection}','already-following','2026-11-17T12:00Z',0,null),
            ('{owner}','{connection}','not-verified',null,1,'prompt'),
            ('{owner}','{connection}','too-old','2026-11-03T12:00Z',1,'prompt'),
            ('{owner}','{connection}','now','{now}',1,'prompt'),
            ('{other}','{connection}','foreign','2026-11-17T12:00Z',1,'prompt');
          insert into public.audience_contacts values
            (1,'{owner}','2026-11-17T12:00Z','instagram_auto_dm'),
            (2,'{owner}','2026-11-11T12:00Z','facebook_auto_dm'),
            (3,'{owner}','2026-11-16T12:00Z','lead_form'),
            (4,'{owner}','2026-11-10T12:00Z','email_capture_block'),
            (5,'{owner}','2026-11-17T12:00Z','order'),
            (6,'{owner}','2026-11-17T12:00Z','newsletter'),
            (7,'{other}','2026-11-17T12:00Z','instagram_auto_dm'),
            (8,'{owner}','2026-11-19T12:00Z','instagram_auto_dm'),
            (9,'{owner}','2026-11-03T12:00Z','instagram_auto_dm');
          insert into public.commerce_orders values
            ('{owner}','usd',5000,1000,'2026-11-17T12:00Z','2026-11-16T12:00Z','partially_refunded'),
            ('{owner}','usd',2500,0,'2026-11-16T12:00Z','2026-06-01T12:00Z','paid'),
            ('{owner}','usd',9000,1000,'2026-11-10T12:00Z','2026-11-10T12:00Z','partially_refunded'),
            ('{owner}','usd',2000,2000,'2026-11-17T12:00Z','2026-11-17T12:00Z','refunded'),
            ('{owner}','usd',100,999,'2026-11-17T12:00Z','2026-11-17T12:00Z','refunded'),
            ('{owner}','usd',700,0,null,'2026-11-17T12:00Z','paid'),
            ('{owner}','inr',10000,1000,'2026-11-17T12:00Z','2026-11-17T12:00Z','partially_refunded'),
            ('{owner}','usd',999999,0,'2026-11-17T12:00Z','2026-11-17T12:00Z','pending'),
            ('{owner}','usd',999999,0,'{now}','{now}','paid'),
            ('{other}','usd',999999,0,'2026-11-17T12:00Z','2026-11-17T12:00Z','paid');
        """)
        result = json.loads(sql(f"set role service_role; select public.get_home_weekly_pulse('{owner}','{now}');").splitlines()[-1])
        assert result["followers"] == {"current": 2, "previous": 2}, result
        assert result["leads"] == {"current": 3, "previous": 1}, result
        assert result["revenue"] == [
            {"currency": "inr", "current": 9000, "previous": 0},
            {"currency": "usd", "current": 7200, "previous": 8000},
        ], result
        for role in ("anon", "authenticated"):
            assert sql(f"select has_function_privilege('{role}','public.get_home_weekly_pulse(uuid,timestamp with time zone)','execute');") == "f"
            rejected = subprocess.run(command, input=f"set role {role}; select public.get_home_weekly_pulse('{owner}','{now}');", text=True, capture_output=True)
            assert rejected.returncode != 0 and "permission denied for function" in rejected.stderr
        sql(f"insert into public.instagram_dm_runs select '{owner}','{connection}', 'bulk-' || n, '2026-11-17T12:00Z',1,'prompt' from generate_series(1,1001) n;")
        beyond_preview = json.loads(sql(f"select public.get_home_weekly_pulse('{owner}','{now}');"))
        assert beyond_preview["followers"]["current"] == 1003
        empty = json.loads(sql(f"select public.get_home_weekly_pulse('10000000-0000-4000-8000-000000000099','{now}');"))
        assert empty["followers"] == {"current": 0, "previous": 0} and empty["revenue"] == []
        print("Weekly pulse SQL passed: tenant isolation, boundaries, follow attribution/deduplication, captured leads, refunds, late payments, currencies, empty periods, >1000 rows, role permissions and idempotent migration.")
    finally:
        if started:
            subprocess.run([str(pgbin / "pg_ctl"), "-D", str(database), "-m", "immediate", "-w", "stop"], check=True, stdout=subprocess.DEVNULL)
