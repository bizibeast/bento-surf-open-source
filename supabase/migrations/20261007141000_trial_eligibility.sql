create table public.bento_trial_owners (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id text not null,
  trial_ends_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.bento_trial_owners enable row level security;
revoke all on public.bento_trial_owners from public, anon, authenticated;
grant all on public.bento_trial_owners to service_role;
grant select on public.bento_trial_owners to authenticated;
create policy own_trial on public.bento_trial_owners for select to authenticated
using (auth_user_id = auth.uid());

create or replace function public.claim_bento_trial(
  p_auth_user_id uuid, p_workspace_id uuid, p_subscription_id text, p_trial_ends_at timestamptz, p_checkout_key uuid
) returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_trial public.bento_trial_owners;
begin
  if p_workspace_id <> p_auth_user_id then raise exception 'Trials are available only for the initial workspace.'; end if;
  if not exists (select 1 from public.bento_trial_checkouts where auth_user_id=p_auth_user_id and workspace_id=p_workspace_id and checkout_key=p_checkout_key) then
    raise exception 'Trial checkout authorization could not be verified.';
  end if;
  if not exists (select 1 from public.workspace_memberships where auth_user_id = p_auth_user_id
    and workspace_id = p_workspace_id and role = 'owner' and status = 'active') then
    raise exception 'Trial workspace ownership could not be verified.';
  end if;
  insert into public.bento_trial_owners(auth_user_id, workspace_id, subscription_id, trial_ends_at)
    values (p_auth_user_id, p_workspace_id, p_subscription_id, p_trial_ends_at)
    on conflict (auth_user_id) do nothing;
  select * into v_trial from public.bento_trial_owners where auth_user_id = p_auth_user_id;
  if v_trial.workspace_id <> p_workspace_id or v_trial.subscription_id <> p_subscription_id then
    raise exception 'This owner has already used their trial.';
  end if;
  return least(v_trial.trial_ends_at, p_trial_ends_at);
end; $$;
revoke all on function public.claim_bento_trial(uuid, uuid, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.claim_bento_trial(uuid, uuid, text, timestamptz, uuid) to service_role;
create index subscriptions_due_trial_reminder on public.subscriptions(trial_ends_at)
where trial_ends_at is not null and status = 'trialing';
notify pgrst, 'reload schema';

-- One durable checkout per owner prevents parallel sessions from starting duplicate trials.
-- Keep uncertain provider requests reserved; support reconciles them before another attempt.
create table public.bento_trial_checkouts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  plan_id text not null check (plan_id in ('store','creator','creator_plus')),
  checkout_key uuid not null unique default gen_random_uuid(),
  checkout_url text,
  checkout_session_id text,
  created_at timestamptz not null default now()
);
alter table public.bento_trial_checkouts enable row level security;
revoke all on public.bento_trial_checkouts from public, anon, authenticated;
grant all on public.bento_trial_checkouts to service_role;
