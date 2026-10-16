-- Explicit server-side null cohort enables general availability; omitted/empty cohorts stay closed.
-- Entitlements, workspace status, creator pause, leases, daily/weekly cadence and provider budgets still apply.
create or replace function public.claim_content_agent_scans(p_limit integer default 3,p_workspace_ids uuid[] default '{}')
returns setof uuid language plpgsql security invoker set search_path = '' as $$
begin
 return query with due as (
   select user_id from public.content_agent_scan_queue where (p_workspace_ids is null or user_id=any(p_workspace_ids)) and next_check_at <= now()
     order by next_check_at, user_id for update skip locked limit greatest(1,least(p_limit,10))
 ) update public.content_agent_scan_queue q set next_check_at = now()+interval '1 hour'
   from due where q.user_id=due.user_id returning q.user_id;
end;
$$;
revoke all on function public.claim_content_agent_scans(integer,uuid[]) from public,anon,authenticated;
grant execute on function public.claim_content_agent_scans(integer,uuid[]) to service_role;


create or replace function public.claim_due_content_agent_signals(p_limit integer default 1,p_workspace_ids uuid[] default '{}')
returns setof public.content_agent_signals language plpgsql security invoker set search_path = '' as $$
declare ws uuid; s public.content_agent_signals; n integer := 0; paused boolean;
begin
 for ws in select p.id from public.profiles p join lateral (
   select min(next_attempt_at) due from public.content_agent_signals where user_id=p.id
     and status in ('pending','processing') and next_attempt_at<=now()
     and (lease_until is null or lease_until<=now())
 ) d on d.due is not null where (p_workspace_ids is null or p.id=any(p_workspace_ids)) order by d.due,p.id for update of p skip locked limit greatest(1,least(p_limit,5))*10
 loop
   select proactive_paused into paused from public.content_agent_preferences where user_id=ws for update;
   if exists(select 1 from public.profiles where id=ws and workspace_status<>'active') then paused:=true; end if;
   select * into s from public.content_agent_signals where user_id=ws and status in ('pending','processing')
     and next_attempt_at<=now() and (lease_until is null or lease_until<=now())
     order by next_attempt_at,id limit 1 for update;
   if not found then continue; end if;
   if s.observed_at<now()-interval '7 days' or s.attempts>=3 or exists(
     select 1 from public.content_agent_signals f where f.user_id=ws and f.feedback='not_relevant' and f.source_keys && case when s.kind='fresh_source' then s.source_ids else '{}'::text[] end
   ) then
     update public.content_agent_signals set status='skipped',lease_key=null,lease_until=null where id=s.id;
     continue;
   end if;
   if coalesce(paused,false) or not public.bento_has_hosted_access(ws)
   or (s.kind='fresh_source' and exists(select 1 from public.creator_content_recommendations where user_id=ws and agent_source_key is null and (feedback in ('saved','not_relevant') or metadata->>'saved'='true'))) or exists(
     select 1 from public.content_agent_signals where user_id=ws and
       (delivered_at>now()-interval '24 hours' or (status='processing' and lease_until>now()))
   ) or (select count(*) from public.content_agent_signals where user_id=ws and
       (delivered_at>now()-interval '7 days' or (status='processing' and lease_until>now())))>=3 then
     update public.content_agent_signals set next_attempt_at=now()+interval '1 hour',status='pending',lease_key=null,lease_until=null where id=s.id;
     continue;
   end if;
   update public.content_agent_signals set status='processing',lease_key=gen_random_uuid(),lease_until=now()+interval '2 minutes',
     next_attempt_at=now()+interval '2 minutes',attempts=attempts+1 where id=s.id returning * into s;
   return next s;
   n:=n+1;
   exit when n>=greatest(1,least(p_limit,5));
 end loop;
end;
$$;
revoke all on function public.claim_due_content_agent_signals(integer,uuid[]) from public,anon,authenticated;
grant execute on function public.claim_due_content_agent_signals(integer,uuid[]) to service_role;

