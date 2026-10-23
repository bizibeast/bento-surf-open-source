-- Run with psql -v ON_ERROR_STOP=1 in an EMPTY disposable local database.
-- Synthetic fixtures only; all schema/data changes roll back.
begin;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.bento_instance_settings(edition text not null);
insert into public.bento_instance_settings values('hosted');
create table public.profiles(
  id uuid primary key,
  plan_id text not null check(plan_id in ('free','store','creator','creator_plus')),
  is_pro boolean not null default false,
  trial_ends_at timestamptz,
  billing_lifecycle jsonb,
  billing_catalog text not null default '2026-10'
);
create table public.complimentary_plan_grants(
  user_id uuid primary key references public.profiles(id),
  plan_id text not null check(plan_id in ('store','creator','creator_plus')),
  status text not null,
  expires_at timestamptz not null
);

-- Existing production definitions from 20261007150000_workspace_billing_lifecycle.
create function public.bento_effective_billing_plan(p_workspace_id uuid,p_surface text default 'tools')
returns text language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.bento_instance_settings where edition='self_hosted') then 'creator_plus'
  else coalesce((select plan from (
    select case when p.billing_lifecycle is null or (p.billing_lifecycle->>'deletingAt' is null and
      (p.billing_lifecycle->>case when p_surface='public' then 'publicStopAt' else 'toolsStopAt' end)::timestamptz>now()) then
      case when p.trial_ends_at>now() then 'creator_plus'
        when p.billing_lifecycle is not null then p.billing_lifecycle->>'plan'
        when p.trial_ends_at is not null then 'free' else p.plan_id end
      else 'free' end as plan from public.profiles p where p.id=p_workspace_id
    union all select plan_id from public.complimentary_plan_grants where user_id=p_workspace_id and status='active' and expires_at>now()
  ) plans order by case plan when 'creator_plus' then 3 when 'creator' then 2 when 'store' then 1 else 0 end desc limit 1),'free') end;
$$;
revoke all on function public.bento_effective_billing_plan(uuid,text) from public;
grant execute on function public.bento_effective_billing_plan(uuid,text) to anon,authenticated,service_role;
create function public.bento_has_brain_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.bento_effective_billing_plan(p_user_id)='creator_plus' or
    (public.bento_effective_billing_plan(p_user_id)='creator' and exists(select 1 from public.profiles where id=p_user_id and billing_catalog='legacy'));
$$;
revoke all on function public.bento_has_brain_access(uuid) from public,anon;
grant execute on function public.bento_has_brain_access(uuid) to authenticated,service_role;
create temporary table prior_contract as
select oid,proname,proacl,prosecdef,provolatile,proconfig
from pg_proc where oid in ('public.bento_effective_billing_plan(uuid,text)'::regprocedure,'public.bento_has_brain_access(uuid)'::regprocedure);

insert into public.profiles(id,plan_id,trial_ends_at)
values('00000000-0000-4000-8000-000000000001','store',now()+interval '1 day');
do $$ begin
  if public.bento_effective_billing_plan('00000000-0000-4000-8000-000000000001')<>'creator_plus'
    or not public.bento_has_brain_access('00000000-0000-4000-8000-000000000001') then
    raise exception 'Fixture does not reproduce the Store trial Brain overgrant';
  end if;
end $$;

\ir ../migrations/20261022213629_selected_trial_plan_entitlement_parity.sql

create function pg_temp.assert_access(p_label text,p_workspace uuid,p_expected text,p_brain boolean)
returns void language plpgsql as $$
declare actual text; brain boolean;
begin
  actual:=public.bento_effective_billing_plan(p_workspace);
  brain:=public.bento_has_brain_access(p_workspace);
  if actual is distinct from p_expected or brain is distinct from p_brain then
    raise exception '%: expected plan %, Brain %; got plan %, Brain %',p_label,p_expected,p_brain,actual,brain;
  end if;
end $$;

do $$
declare workspace uuid:='00000000-0000-4000-8000-000000000001'; tier text; trial_state text;
  grant_tier text; grant_state text; expected text; base_plan text; checks integer:=0;
begin
  -- Every paid tier, with no trial, active trial, expired trial, and exact expiry.
  -- Cross each with all grant tiers and active/expired/revoked states. This also
  -- proves a lower grant never downgrades a real paid Creator Plus workspace.
  foreach tier in array array['store','creator','creator_plus'] loop
    foreach trial_state in array array['none','active','expired','boundary'] loop
      update public.profiles set plan_id=tier,is_pro=true,billing_lifecycle=null,
        trial_ends_at=case trial_state when 'active' then now()+interval '1 day' when 'expired' then now()-interval '1 day' when 'boundary' then now() end
      where id=workspace;
      base_plan:=case when trial_state in ('expired','boundary') then 'free' else tier end;
      perform pg_temp.assert_access(tier||'/'||trial_state,workspace,base_plan,base_plan='creator_plus');
      checks:=checks+1;
      foreach grant_tier in array array['store','creator','creator_plus'] loop
        foreach grant_state in array array['active','expired','revoked'] loop
          insert into public.complimentary_plan_grants values(workspace,grant_tier,
            case when grant_state='revoked' then 'revoked' else 'active' end,
            case when grant_state='expired' then now()-interval '1 second' else now()+interval '1 day' end);
          expected:=base_plan;
          if grant_state='active' and array_position(array['free','store','creator','creator_plus'],grant_tier)>array_position(array['free','store','creator','creator_plus'],expected) then
            expected:=grant_tier;
          end if;
          perform pg_temp.assert_access(tier||'/'||trial_state||'/'||grant_tier||'/'||grant_state,workspace,expected,expected='creator_plus');
          checks:=checks+1;
          delete from public.complimentary_plan_grants where user_id=workspace;
        end loop;
      end loop;
    end loop;
  end loop;
  raise notice 'PASS: % paid/trial/grant entitlement and Brain access cases',checks;
end $$;

do $$
declare workspace uuid:='00000000-0000-4000-8000-000000000001'; tier text; trial_state text; lifecycle jsonb;
begin
  foreach tier in array array['store','creator','creator_plus'] loop
    lifecycle:=jsonb_build_object('episodeId','fixture','subscriptionId','fixture','reason','past_due','plan',tier,
      'stoppedAt',now()-interval '1 day','toolsStopAt',now()+interval '2 days',
      'publicStopAt',now()+interval '6 days','deleteAfter',now()+interval '89 days','deletingAt',null);
    foreach trial_state in array array['active','expired'] loop
      update public.profiles set plan_id='creator_plus',billing_lifecycle=lifecycle,
        trial_ends_at=case when trial_state='active' then now()+interval '1 day' else now()-interval '1 day' end where id=workspace;
      perform pg_temp.assert_access(tier||' lifecycle overrides '||trial_state||' trial',workspace,tier,tier='creator_plus');
    end loop;
    update public.profiles set billing_lifecycle=jsonb_set(lifecycle,'{toolsStopAt}',to_jsonb(now())) where id=workspace;
    perform pg_temp.assert_access(tier||' tools deadline',workspace,'free',false);
    if public.bento_effective_billing_plan(workspace,'public')<>tier then raise exception 'Public grace window lost for %',tier; end if;
    update public.profiles set billing_lifecycle=jsonb_set(lifecycle,'{deletingAt}',to_jsonb(now())) where id=workspace;
    perform pg_temp.assert_access(tier||' deletion',workspace,'free',false);
    if public.bento_effective_billing_plan(workspace,'public')<>'free' then raise exception 'Deleting workspace has public access'; end if;
    insert into public.complimentary_plan_grants values(workspace,tier,'active',now()+interval '1 day');
    perform pg_temp.assert_access(tier||' active grant survives closed lifecycle',workspace,tier,tier='creator_plus');
    delete from public.complimentary_plan_grants where user_id=workspace;
  end loop;
  update public.profiles set plan_id='creator',billing_catalog='legacy',billing_lifecycle=null,trial_ends_at=now()+interval '1 day' where id=workspace;
  perform pg_temp.assert_access('legacy Creator Brain retained',workspace,'creator',true);
  update public.profiles set trial_ends_at=now() where id=workspace;
  perform pg_temp.assert_access('expired legacy Creator trial',workspace,'free',false);
  update public.profiles set plan_id='free',billing_catalog='2026-10',trial_ends_at=now()+interval '1 day' where id=workspace;
  perform pg_temp.assert_access('free profile never elevated by trial',workspace,'free',false);
  perform pg_temp.assert_access('missing workspace',gen_random_uuid(),'free',false);
  update public.bento_instance_settings set edition='self_hosted';
  perform pg_temp.assert_access('self-hosted edition retained',workspace,'creator_plus',true);
  raise notice 'PASS: lifecycle precedence, deadline/deletion gates, legacy access, missing workspace and self-hosted edition';
end $$;

do $$ begin
  if exists(select 1 from prior_contract prior join pg_proc current on current.oid=prior.oid
    where (current.proacl,current.prosecdef,current.provolatile,current.proconfig) is distinct from
      (prior.proacl,prior.prosecdef,prior.provolatile,prior.proconfig)) then
    raise exception 'Migration changed a helper ACL or execution contract';
  end if;
  if has_function_privilege('anon','public.bento_has_brain_access(uuid)','execute') then
    raise exception 'Brain helper exposed to anon';
  end if;
  raise notice 'PASS: existing helper identity, ACL, security mode, volatility and search_path retained';
end $$;
rollback;
