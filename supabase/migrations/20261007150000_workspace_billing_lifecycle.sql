alter table public.profiles add column billing_lifecycle jsonb;

create or replace function public.protect_hosted_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() in ('authenticated','anon') then
    if new.plan_id is distinct from old.plan_id or new.is_pro is distinct from old.is_pro
      or new.billing_catalog is distinct from old.billing_catalog
      or new.trial_ends_at is distinct from old.trial_ends_at
      or new.billing_lifecycle is distinct from old.billing_lifecycle then
      raise exception 'Billing access is managed by the server.';
    end if;
    if new.billing_catalog='2026-10' and new.onboarded and not old.onboarded then
      raise exception 'Complete verified onboarding activation first.';
    end if;
  end if;
  return new;
end; $$;

create function public.reconcile_workspace_billing_lifecycle(
  p_workspace_id uuid, p_subscription_id text, p_reason text, p_plan text, p_stopped_at timestamptz, p_last_paid_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior jsonb; result jsonb; stopped timestamptz; reason text;
begin
  select billing_lifecycle into prior from public.profiles where id=p_workspace_id for update;
  if not found then raise exception 'Workspace not found.'; end if;
  if exists(select 1 from public.bento_instance_settings where edition='self_hosted') then return null; end if;
  if prior->>'deletingAt' is not null then
    if p_reason is null then raise exception 'Workspace deletion is in progress; contact support.'; end if;
    return prior;
  end if;
  if p_reason is null then
    update public.profiles set billing_lifecycle=null where id=p_workspace_id;
    return null;
  end if;
  if p_reason not in ('past_due','canceled','expired') or p_stopped_at is null
    or p_plan not in ('store','creator','creator_plus') or nullif(p_subscription_id,'') is null then
    raise exception 'Invalid billing lifecycle.';
  end if;
  stopped := p_stopped_at;
  reason := p_reason;
  -- A payment can recover an episode even if its webhook was lost before the next failure.
  if prior->>'subscriptionId'=p_subscription_id and p_last_paid_at>(prior->>'stoppedAt')::timestamptz then prior:=null; end if;
  if prior->>'subscriptionId'=p_subscription_id and (prior->>'stoppedAt')::timestamptz <= now() then
    stopped := least(stopped,(prior->>'stoppedAt')::timestamptz);
    -- Dunning termination never shortens or restarts the original failed-payment grace period.
    if prior->>'reason'='past_due' then reason := 'past_due'; end if;
  end if;
  result := jsonb_build_object(
    'episodeId',case when prior->>'subscriptionId'=p_subscription_id then prior->>'episodeId' else gen_random_uuid()::text end,
    'subscriptionId',p_subscription_id,'reason',reason,'plan',p_plan,'stoppedAt',stopped,
    'toolsStopAt',stopped + case when reason='past_due' then interval '3 days' else interval '0' end,
    'publicStopAt',stopped + case when reason='past_due' then interval '7 days' else interval '0' end,
    'deleteAfter',greatest(stopped + interval '90 days',coalesce((prior->>'deleteAfter')::timestamptz,stopped + interval '90 days')),'deletingAt',null
  );
  update public.profiles set billing_lifecycle=result where id=p_workspace_id;
  return result;
end; $$;
revoke all on function public.reconcile_workspace_billing_lifecycle(uuid,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.reconcile_workspace_billing_lifecycle(uuid,text,text,text,timestamptz,timestamptz) to service_role;

create function public.bento_billing_allows(p_workspace_id uuid,p_surface text default 'tools')
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.bento_instance_settings where edition='self_hosted')
    or exists(select 1 from public.complimentary_plan_grants where user_id=p_workspace_id and status='active' and expires_at>now())
    or exists(select 1 from public.profiles where id=p_workspace_id and
      (billing_lifecycle is null or (billing_lifecycle->>'deletingAt' is null and
       (billing_lifecycle->>case when p_surface='public' then 'publicStopAt' else 'toolsStopAt' end)::timestamptz>now())));
$$;
revoke all on function public.bento_billing_allows(uuid,text) from public;
grant execute on function public.bento_billing_allows(uuid,text) to anon,authenticated,service_role;

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

create or replace function public.bento_has_hosted_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.bento_effective_billing_plan(p_user_id) in ('store','creator','creator_plus')
    or (public.bento_billing_allows(p_user_id) and exists(select 1 from public.profiles where id=p_user_id and billing_catalog='legacy'));
$$;
create or replace function public.bento_has_creator_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.bento_effective_billing_plan(p_user_id) in ('creator','creator_plus');
$$;
create or replace function public.bento_has_brain_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.bento_effective_billing_plan(p_user_id)='creator_plus' or
    (public.bento_effective_billing_plan(p_user_id)='creator' and exists(select 1 from public.profiles where id=p_user_id and billing_catalog='legacy'));
$$;
create or replace function public.bento_has_advanced_dms(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.bento_has_creator_access(p_user_id) or
    (public.bento_effective_billing_plan(p_user_id)='store' and exists(select 1 from public.profiles where id=p_user_id and billing_catalog='legacy'));
$$;
create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.workspace_memberships m join public.profiles p on p.id=m.workspace_id
    where m.auth_user_id=(select auth.uid()) and m.workspace_id=p_workspace_id and m.role='owner' and m.status='active'
    and p.workspace_status='active' and public.bento_billing_allows(p_workspace_id));
$$;

create or replace function public.pause_unentitled_auto_dms()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Billing pauses are enforced at execution time; preserve saved rules for recovery.
  if new.billing_lifecycle is not null then return new; end if;
  if not public.bento_has_advanced_dms(new.id) then
    update public.instagram_dm_automations set enabled = false where user_id = new.id and enabled and (
      coalesce(array_length(excluded_keywords, 1), 0) > 0 or public_reply_enabled or opening_message is not null
      or confirmation_button_label is not null or email_capture_enabled or email_marketing_consent_enabled or follow_gate_enabled);
    update public.facebook_dm_automations set enabled = false where user_id = new.id and enabled and (
      coalesce(array_length(excluded_keywords, 1), 0) > 0 or public_reply_enabled or opening_message is not null
      or confirmation_button_label is not null or email_capture_enabled or email_marketing_consent_enabled);
    update public.twitter_dm_automations set enabled = false where user_id = new.id and enabled and coalesce(array_length(excluded_keywords, 1), 0) > 0;
  end if;
  return new;
end; $$;

-- Public API clients must respect the same deadline as the server renderers.
create policy billing_public_read on public.profiles as restrictive for select to anon
using (public.bento_billing_allows(id,'public'));
create policy billing_authenticated_read on public.profiles as restrictive for select to authenticated
using (public.bento_owns_workspace(id) or public.bento_billing_allows(id,'public'));
do $$ declare r record; begin
  for r in select distinct c.conrelid::regclass as tbl,a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    where c.contype='f' and c.confrelid='public.profiles'::regclass and array_length(c.conkey,1)=1
      and a.attname in ('user_id','creator_id','workspace_id')
      and c.conrelid in (select oid from pg_class where relrowsecurity)
  loop
    execute format('create policy billing_public_read_%I on %s as restrictive for select to anon using (public.bento_billing_allows(%I,''public''))',r.col,r.tbl,r.col);
    execute format('create policy billing_authenticated_read_%I on %s as restrictive for select to authenticated using (public.bento_owns_workspace(%I) or public.bento_billing_allows(%I,''public''))',r.col,r.tbl,r.col,r.col);
  end loop;
end $$;

-- Billing details are owner-facing through server functions, never public profile data.
revoke select on public.profiles from public,anon,authenticated;
-- Preserve the established per-column allowlist from security_hardening and
-- later feature migrations; do not widen it to private payment identifiers.
revoke select (billing_lifecycle) on public.profiles from public,anon,authenticated;
notify pgrst,'reload schema';
