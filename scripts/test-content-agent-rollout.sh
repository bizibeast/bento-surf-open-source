#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container="${BENTO_SUPABASE_DB_CONTAINER:-supabase_db_cloud-supabase-private}"
database="${BENTO_AGENT_TEST_DATABASE:?Set BENTO_AGENT_TEST_DATABASE to an isolated local database with the rollout migration applied}"
[[ "$database" != postgres ]] || { echo 'Use an isolated validation database'; exit 1; }
psql_local() { docker exec -i "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 "$@"; }
psql_local < supabase/tests/content_agent_rollout.sql
printf 'PASS: rollout, delivery preference/source races, prepared delivery and suppression contracts\n'
# Independent sessions: a preference/source writer commits while final delivery is waiting.
workspace=80000000-0000-4000-8000-000000000003
cleanup() { psql_local -c "delete from public.profiles where id='$workspace'" >/dev/null; }
trap cleanup EXIT
logdir="$(mktemp -d /tmp/bento-delivery-race.XXXXXX)"
psql_local <<SQL
insert into public.profiles(id,username,plan_id,trial_ends_at) values('$workspace','rollout_concurrency','creator_plus',now()+interval '1 day');
select public.ensure_content_named_agent('$workspace');
select public.update_content_agent_preferences('$workspace','{"platforms":["linkedin"]}');
insert into public.creator_content_recommendations(user_id,fingerprint,kind,title) values('$workspace','concurrent','trend','Synthetic fixture');
update public.creator_content_recommendations set agent_source_key='x:race' where user_id='$workspace';
select public.enqueue_content_agent_signal('$workspace','fresh_source','race',array['x:race'],now());
SQL
# Only one of two actual connections can reserve the workspace cadence.
(psql_local -c "select id from public.claim_due_content_agent_signals(1,array['$workspace'::uuid])" >"$logdir/claim-a" 2>&1) & first=$!
(psql_local -c "select id from public.claim_due_content_agent_signals(1,array['$workspace'::uuid])" >"$logdir/claim-b" 2>&1) & second=$!
wait "$first"; wait "$second"
psql_local -c "do \$\$ begin if (select sum(attempts) from public.content_agent_signals where user_id='$workspace')<>1 then raise exception 'Duplicate cadence claim';end if;end \$\$;"
for gate in platform source; do
  if [[ "$gate" == source ]]; then
    psql_local -c "select public.update_content_agent_preferences('$workspace','{\"platforms\":[\"linkedin\"]}'); update public.content_agent_signals set next_attempt_at=now() where user_id='$workspace'; select id from public.claim_due_content_agent_signals(1,array['$workspace'::uuid]);" >/dev/null
    mutation="update public.creator_content_recommendations set feedback='saved' where user_id='$workspace';"
  else
    mutation="select public.update_content_agent_preferences('$workspace','{\"platforms\":[\"instagram\"]}');"
  fi
  (psql_local -c "set application_name='bento_rollout_writer'; begin; $mutation select pg_sleep(2); commit;" >"$logdir/$gate-writer" 2>&1) & writer=$!
  ready=false
  for attempt in {1..80}; do
    if [[ "$(psql_local -Atc "select count(*) from pg_stat_activity where datname=current_database() and application_name='bento_rollout_writer' and wait_event='PgSleep'")" == 1 ]]; then ready=true; break; fi
    sleep 0.05
  done
  [[ "$ready" == true ]] || { echo 'Writer did not reach lock barrier'; exit 1; }
  psql_local <<SQL >"$logdir/$gate-finish" 2>&1
 do \$\$ declare s public.content_agent_signals; mid uuid; begin
 select * into strict s from public.content_agent_signals where user_id='$workspace';
 mid:=public.finish_content_agent_signal(s.user_id,s.id,s.lease_key,jsonb_build_object('message','Synthetic race','cards',jsonb_build_array(jsonb_build_object('type','draft','platform','linkedin')),'proactive',jsonb_build_object('signalId',s.id,'sourceKeys',jsonb_build_array('x:race'))),true);
 if mid is not null then raise exception 'Concurrent $gate gate bypass';end if;
 end \$\$;
SQL
  wait "$writer"
done
psql_local -c "do \$\$ begin if exists(select 1 from public.content_agent_messages where user_id='$workspace') then raise exception 'Concurrent blocked delivery created message';end if;end \$\$;"
printf 'PASS: independent claim contention and waiting platform/source feedback transactions; session logs %s\n' "$logdir"
