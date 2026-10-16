-- Serialize provider reads and atomically apply their snapshots. A worker that
-- outlives its lease cannot overwrite a newer recovery or failed-payment episode.
create table public.workspace_billing_sync_leases (
  workspace_id uuid primary key references public.profiles(id) on delete cascade,
  lease_key uuid not null,
  lease_until timestamptz not null
);
alter table public.workspace_billing_sync_leases enable row level security;
revoke all on public.workspace_billing_sync_leases from public,anon,authenticated;
grant all on public.workspace_billing_sync_leases to service_role;

create function public.claim_workspace_billing_sync(p_workspace_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare token uuid:=gen_random_uuid(); claimed uuid; begin
  perform 1 from public.profiles where id=p_workspace_id for update;
  if not found then return null; end if;
  insert into public.workspace_billing_sync_leases(workspace_id,lease_key,lease_until)
    values(p_workspace_id,token,clock_timestamp()+interval '5 minutes')
    on conflict(workspace_id) do update set lease_key=excluded.lease_key,lease_until=excluded.lease_until
      where workspace_billing_sync_leases.lease_until<=clock_timestamp()
    returning lease_key into claimed;
  return claimed;
end; $$;
create function public.release_workspace_billing_sync(p_workspace_id uuid,p_lease_key uuid)
returns void language sql security definer set search_path='' as $$
  delete from public.workspace_billing_sync_leases where workspace_id=p_workspace_id and lease_key=p_lease_key;
$$;

create function public.apply_workspace_billing_snapshot(p_workspace_id uuid,p_lease_key uuid,p_subscription jsonb,p_lifecycle jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare snapshot public.subscriptions; lifecycle jsonb; grant_plan text; effective_plan text; begin
  perform 1 from public.profiles where id=p_workspace_id for update;
  if not exists(select 1 from public.workspace_billing_sync_leases where workspace_id=p_workspace_id
    and lease_key=p_lease_key and lease_until>clock_timestamp()) then raise exception 'Billing reconciliation lease expired.'; end if;
  snapshot:=jsonb_populate_record(null::public.subscriptions,p_subscription);
  if snapshot.user_id is distinct from p_workspace_id then raise exception 'Billing workspace mismatch.'; end if;
  if p_lifecycle is not null then
    lifecycle:=public.reconcile_workspace_billing_lifecycle(p_workspace_id,snapshot.dodo_subscription_id,p_lifecycle->>'reason',
      p_lifecycle->>'plan',(p_lifecycle->>'stoppedAt')::timestamptz,(p_lifecycle->>'lastPaidAt')::timestamptz);
  end if;
  select plan_id into grant_plan from public.complimentary_plan_grants where user_id=p_workspace_id and status='active' and expires_at>now();
  select plan into effective_plan from (values(snapshot.plan_id),(grant_plan)) candidates(plan)
    where plan is not null order by case plan when 'creator_plus' then 3 when 'creator' then 2 when 'store' then 1 else 0 end desc limit 1;
  update public.profiles set plan_id=effective_plan,is_pro=effective_plan<>'free',
    workspace_status=case when grant_plan in ('store','creator','creator_plus') or snapshot.status::text in ('active','trialing')
      or (lifecycle->>'toolsStopAt')::timestamptz>now() then 'active' else 'locked' end,
    billing_catalog=snapshot.billing_catalog,trial_ends_at=snapshot.trial_ends_at where id=p_workspace_id;
  insert into public.subscriptions(user_id,plan_id,pending_plan_id,pending_plan_effective_at,status,billing_catalog,trial_ends_at,
    dodo_subscription_id,stripe_subscription_id,product_id,price_id,customer_id,amount,currency,billing_interval,
    cancel_at_period_end,canceled_at,current_period_end,contact_tier_contacts,storage_addon_units)
  values(p_workspace_id,snapshot.plan_id,snapshot.pending_plan_id,snapshot.pending_plan_effective_at,snapshot.status,snapshot.billing_catalog,snapshot.trial_ends_at,
    snapshot.dodo_subscription_id,snapshot.stripe_subscription_id,snapshot.product_id,snapshot.price_id,snapshot.customer_id,snapshot.amount,snapshot.currency,snapshot.billing_interval,
    snapshot.cancel_at_period_end,snapshot.canceled_at,snapshot.current_period_end,coalesce(snapshot.contact_tier_contacts,500),coalesce(snapshot.storage_addon_units,0))
  on conflict(user_id) do update set plan_id=excluded.plan_id,pending_plan_id=excluded.pending_plan_id,pending_plan_effective_at=excluded.pending_plan_effective_at,
    status=excluded.status,billing_catalog=excluded.billing_catalog,trial_ends_at=excluded.trial_ends_at,dodo_subscription_id=excluded.dodo_subscription_id,
    stripe_subscription_id=excluded.stripe_subscription_id,product_id=excluded.product_id,price_id=excluded.price_id,customer_id=excluded.customer_id,
    amount=excluded.amount,currency=excluded.currency,billing_interval=excluded.billing_interval,cancel_at_period_end=excluded.cancel_at_period_end,
    canceled_at=excluded.canceled_at,current_period_end=excluded.current_period_end,
    contact_tier_contacts=case when p_subscription?'contact_tier_contacts' then excluded.contact_tier_contacts else subscriptions.contact_tier_contacts end,
    storage_addon_units=case when p_subscription?'storage_addon_units' then excluded.storage_addon_units else subscriptions.storage_addon_units end;
end; $$;
revoke all on function public.claim_workspace_billing_sync(uuid),public.release_workspace_billing_sync(uuid,uuid),public.apply_workspace_billing_snapshot(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_workspace_billing_sync(uuid),public.release_workspace_billing_sync(uuid,uuid),public.apply_workspace_billing_snapshot(uuid,uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
