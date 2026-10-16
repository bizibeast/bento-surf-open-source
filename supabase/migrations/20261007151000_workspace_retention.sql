create table public.workspace_retention_deletions (
  episode_id uuid primary key,
  workspace_id uuid references public.profiles(id) on delete set null,
  original_workspace_id uuid not null,
  owner_id uuid references auth.users(id) on delete set null,
  status text not null default 'claimed' check(status in ('claimed','complete')),
  lease_key uuid not null,
  lease_until timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.workspace_retention_deletions enable row level security;
revoke all on public.workspace_retention_deletions from public,anon,authenticated;
grant all on public.workspace_retention_deletions to service_role;

create function public.ensure_workspace_deletion_notice_window(p_workspace_id uuid,p_episode_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare lifecycle jsonb; begin
  select billing_lifecycle into lifecycle from public.profiles where id=p_workspace_id for update;
  if lifecycle->>'episodeId' is distinct from p_episode_id::text or lifecycle->>'deletingAt' is not null then return; end if;
  if not exists(select 1 from public.email_outbox where
    event_key='billing-email:workspace-lifecycle:'||p_workspace_id::text||':'||p_episode_id::text||':workspace_deletion_warning'
    and status='sent' and delivered_at is not null and bounced_at is null and complained_at is null) then
    update public.profiles set billing_lifecycle=jsonb_set(lifecycle,'{deleteAfter}',to_jsonb(greatest((lifecycle->>'deleteAfter')::timestamptz,now()+interval '7 days')))
      where id=p_workspace_id;
  end if;
end; $$;

create function public.claim_workspace_retention(p_workspace_id uuid,p_episode_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare lifecycle jsonb; owner uuid; job public.workspace_retention_deletions; lease uuid:=gen_random_uuid(); begin
  select billing_lifecycle into lifecycle from public.profiles where id=p_workspace_id for update;
  if lifecycle->>'episodeId' is distinct from p_episode_id::text or (lifecycle->>'deleteAfter')::timestamptz>now()
    or exists(select 1 from public.bento_instance_settings where edition='self_hosted')
    or exists(select 1 from public.complimentary_plan_grants where user_id=p_workspace_id and status='active' and expires_at>now()) then return null; end if;
  if not exists(select 1 from public.subscriptions where user_id=p_workspace_id and dodo_subscription_id=lifecycle->>'subscriptionId'
    and status::text='canceled') then return null; end if;
  if not exists(select 1 from public.email_outbox where
    event_key='billing-email:workspace-lifecycle:'||p_workspace_id::text||':'||p_episode_id::text||':workspace_deletion_warning'
    and status='sent' and delivered_at<=now()-interval '7 days' and bounced_at is null and complained_at is null) then return null; end if;
  select auth_user_id into owner from public.workspace_memberships where workspace_id=p_workspace_id and role='owner' and status='active';
  if owner is null then return null; end if;
  select * into job from public.workspace_retention_deletions where episode_id=p_episode_id for update;
  if job.status='complete' or job.lease_until>now() then return null; end if;
  insert into public.workspace_retention_deletions(episode_id,workspace_id,original_workspace_id,owner_id,lease_key,lease_until)
    values(p_episode_id,p_workspace_id,p_workspace_id,owner,lease,now()+interval '15 minutes')
    on conflict(episode_id) do update set lease_key=excluded.lease_key,lease_until=excluded.lease_until;
  update public.profiles set workspace_status='locked',billing_lifecycle=jsonb_set(lifecycle,'{deletingAt}',to_jsonb(coalesce((lifecycle->>'deletingAt')::timestamptz,now()))) where id=p_workspace_id;
  return jsonb_build_object('episodeId',p_episode_id,'workspaceId',p_workspace_id,'ownerId',owner,'leaseKey',lease);
end; $$;

create function public.finish_workspace_retention(p_episode_id uuid,p_lease_key uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.workspace_retention_deletions; lifecycle jsonb; begin
  select * into job from public.workspace_retention_deletions where episode_id=p_episode_id for update;
  if job.status is distinct from 'claimed' or job.lease_key<>p_lease_key or job.lease_until<=now() then return false; end if;
  -- Lock the auth identity before checking its memberships. New membership FKs
  -- cannot race an account removal, and other workspaces always keep the login.
  perform 1 from auth.users where id=job.owner_id for update;
  select billing_lifecycle into lifecycle from public.profiles where id=job.workspace_id for update;
  if lifecycle->>'episodeId' is distinct from p_episode_id::text or lifecycle->>'deletingAt' is null
    or (lifecycle->>'deleteAfter')::timestamptz>now()
    or exists(select 1 from public.bento_instance_settings where edition='self_hosted')
    or exists(select 1 from public.complimentary_plan_grants where user_id=job.workspace_id and status='active' and expires_at>now())
    or not exists(select 1 from public.subscriptions where user_id=job.workspace_id and dodo_subscription_id=lifecycle->>'subscriptionId' and status::text='canceled') then return false; end if;
  if not exists(select 1 from public.email_outbox where
    event_key='billing-email:workspace-lifecycle:'||job.workspace_id::text||':'||p_episode_id::text||':workspace_deletion_warning'
    and status='sent' and delivered_at<=now()-interval '7 days' and bounced_at is null and complained_at is null) then return false; end if;
  -- Detach both SET NULL paths together before profile/product cascades. Otherwise
  -- PostgreSQL can check the still-present product FK between the two cascades.
  update public.commerce_orders set creator_id=null,product_id=null where creator_id=job.workspace_id;
  delete from public.profiles where id=job.workspace_id;
  if not exists(select 1 from public.workspace_memberships where auth_user_id=job.owner_id) then
    delete from auth.users where id=job.owner_id;
  end if;
  update public.workspace_retention_deletions set status='complete',completed_at=now() where episode_id=p_episode_id;
  return true;
end; $$;

create function public.guard_retention_reactivation()
returns trigger language plpgsql security definer set search_path='' as $$ begin
  -- Serialize grants with the profile lock held by the deletion claim so a
  -- concurrent grant cannot commit after external cleanup has been authorized.
  perform 1 from public.profiles where id=new.user_id for update;
  if new.status='active' and new.expires_at>now() and exists(select 1 from public.profiles where id=new.user_id and billing_lifecycle->>'deletingAt' is not null)
    then raise exception 'Workspace deletion is in progress; contact support.'; end if;
  return new;
end; $$;
create trigger guard_retention_reactivation before insert or update on public.complimentary_plan_grants for each row execute function public.guard_retention_reactivation();

-- Grant revocation/expiry also take the profile lock before the grant row.
create or replace function public.revoke_complimentary_plan(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
begin
  -- Use the same profile -> grant lock order as grant creation and retention.
  select user_id into v_user_id from public.complimentary_plan_grants where id=p_grant_id;
  perform 1 from public.profiles where id=v_user_id for update;
  update public.complimentary_plan_grants
  set status = 'revoked', revoked_at = now(), updated_at = now()
  where id = p_grant_id and status = 'active'
  returning user_id into v_user_id;
  if v_user_id is null then
    raise exception 'That complimentary plan is no longer active.';
  end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by case subscription.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 else 3 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator', 'creator_plus') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'),
    workspace_status = case when billing_catalog='legacy' or trial_ends_at>now() or (trial_ends_at is null and v_paid_plan<>'free') then 'active' else 'locked' end, updated_at = now()
  where id = v_user_id;
end;
$$;

create or replace function public.expire_complimentary_plan_grant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_paid_plan text := 'free';
begin
  -- Use the same profile -> grant lock order as grant creation and retention.
  select user_id into v_user_id from public.complimentary_plan_grants where id=p_grant_id;
  perform 1 from public.profiles where id=v_user_id for update;
  update public.complimentary_plan_grants
  set status = 'expired', updated_at = now()
  where id = p_grant_id and status = 'active' and expires_at <= now()
  returning user_id into v_user_id;
  if v_user_id is null then return; end if;

  select subscription.plan_id into v_paid_plan
  from public.subscriptions subscription
  where subscription.user_id = v_user_id
    and subscription.status::text in ('active', 'trialing', 'past_due')
  order by case subscription.plan_id when 'creator_plus' then 0 when 'creator' then 1 when 'store' then 2 else 3 end,
    subscription.updated_at desc
  limit 1;
  if coalesce(v_paid_plan, 'free') not in ('store', 'creator', 'creator_plus') then
    v_paid_plan := 'free';
  end if;

  update public.profiles
  set plan_id = v_paid_plan, is_pro = (v_paid_plan <> 'free'),
    workspace_status = case when billing_catalog='legacy' or trial_ends_at>now() or (trial_ends_at is null and v_paid_plan<>'free') then 'active' else 'locked' end, updated_at = now()
  where id = v_user_id;
end;
$$;

revoke all on function public.ensure_workspace_deletion_notice_window(uuid,uuid),public.claim_workspace_retention(uuid,uuid),public.finish_workspace_retention(uuid,uuid),public.guard_retention_reactivation() from public,anon,authenticated;
grant execute on function public.ensure_workspace_deletion_notice_window(uuid,uuid),public.claim_workspace_retention(uuid,uuid),public.finish_workspace_retention(uuid,uuid) to service_role;
notify pgrst,'reload schema';
