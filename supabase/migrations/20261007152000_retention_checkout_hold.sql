-- Dodo checkout sessions last 24 hours. A 25-hour hold covers provider latency
-- and prevents cleanup racing a card form opened before the retention deadline.
create table public.workspace_recovery_checkouts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  session_id text,
  checkout_url text,
  created_at timestamptz not null default now()
);
create index workspace_recovery_checkouts_workspace on public.workspace_recovery_checkouts(workspace_id,created_at);
alter table public.workspace_recovery_checkouts enable row level security;
revoke all on public.workspace_recovery_checkouts from public,anon,authenticated;
grant all on public.workspace_recovery_checkouts to service_role;

create function public.reserve_workspace_recovery_checkout(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare lifecycle jsonb; existing public.workspace_recovery_checkouts; reservation uuid; begin
  select billing_lifecycle into lifecycle from public.profiles where id=p_workspace_id for update;
  if not found then raise exception 'Workspace not found.'; end if;
  if lifecycle is null then return null; end if;
  if lifecycle->>'deletingAt' is not null or (lifecycle->>'deleteAfter')::timestamptz<=now() then
    raise exception 'The workspace retention period has ended. Contact support before starting a subscription.';
  end if;
  select * into existing from public.workspace_recovery_checkouts where workspace_id=p_workspace_id and created_at>now()-interval '25 hours' order by created_at desc limit 1;
  if found then
    if existing.checkout_url is null or existing.created_at<=now()-interval '24 hours' then
      raise exception 'The previous recovery checkout needs verification. Contact support to resume safely.';
    end if;
    return jsonb_build_object('id',existing.id,'url',existing.checkout_url);
  end if;
  insert into public.workspace_recovery_checkouts(workspace_id) values(p_workspace_id) returning id into reservation;
  return jsonb_build_object('id',reservation,'url',null);
end; $$;
revoke all on function public.reserve_workspace_recovery_checkout(uuid) from public,anon,authenticated;
grant execute on function public.reserve_workspace_recovery_checkout(uuid) to service_role;

-- Holding the profile row in both this trigger and checkout reservation serializes
-- the decision before external domain/blob deletion begins.
create function public.guard_retention_checkout_hold()
returns trigger language plpgsql security definer set search_path='' as $$ begin
  if new.billing_lifecycle->>'deletingAt' is not null and old.billing_lifecycle->>'deletingAt' is null
    and exists(select 1 from public.workspace_recovery_checkouts where workspace_id=new.id and created_at>now()-interval '25 hours') then
    raise exception 'A recovery checkout is still within its payment window.';
  end if;
  return new;
end; $$;
create trigger guard_retention_checkout_hold before update of billing_lifecycle on public.profiles for each row execute function public.guard_retention_checkout_hold();
revoke all on function public.guard_retention_checkout_hold() from public,anon,authenticated;
notify pgrst,'reload schema';
