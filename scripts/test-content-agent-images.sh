#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="${BENTO_SUPABASE_DB_CONTAINER:-supabase_db_cloud-supabase-private}"
database="${BENTO_IMAGE_TEST_DATABASE:?Set BENTO_IMAGE_TEST_DATABASE to an isolated local database with Task 7 migration applied}"
psql_local() { docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 "$@"; }
psql_local < supabase/tests/content_agent_images.sql
# Independent PostgreSQL sessions contend on the workspace lock at 99 successes.
workspace=70000000-0000-4000-8000-000000000003
cleanup() { psql_local -c "delete from public.profiles where id='$workspace'" >/dev/null; }
trap cleanup EXIT
psql_local <<SQL
insert into public.profiles(id,username) values('$workspace','image_concurrency_contract');
select public.ensure_content_named_agent('$workspace');
select public.update_content_agent_preferences('$workspace','{"generate_images":true}');
insert into public.content_agent_image_jobs(user_id,request_key,status,completed_at,output_count,created_at) select '$workspace','success-'||n,'ready',now(),1,now()-interval '2 minutes' from generate_series(1,99)n;
SQL
logdir="$(mktemp -d /tmp/bento-image-race.XXXXXX)"
(psql_local -c "select public.reserve_content_agent_image('$workspace','race-a',1)" >"$logdir/a" 2>&1) & first=$!
(psql_local -c "select public.reserve_content_agent_image('$workspace','race-b',1)" >"$logdir/b" 2>&1) & second=$!
set +e
wait "$first"; a=$?
wait "$second"; b=$?
set -e
if [[ "$a" -eq 0 && "$b" -eq 0 ]] || [[ "$a" -ne 0 && "$b" -ne 0 ]]; then cat "$logdir/a" "$logdir/b"; exit 1; fi
psql_local <<SQL
do \$\$ declare q jsonb; begin q:=public.content_agent_image_quota('$workspace'); if (q->>'successful')::int<>99 or (q->>'pending')::int<>1 then raise exception 'Concurrent quota overflow: %',q; end if; end \$\$;
SQL
printf 'PASS: SQL contracts and independent 99→100→101 contention; session logs %s\n' "$logdir"
