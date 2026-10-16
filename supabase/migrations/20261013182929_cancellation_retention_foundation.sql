-- A trial checkout records the terms offered at creation. Existing seven-day
-- checkouts keep those terms when new checkouts move to three days.
alter table public.bento_trial_checkouts
  add column trial_days integer not null default 7 check (trial_days in (3, 7));
alter table public.bento_trial_owners
  add column trial_days integer not null default 7 check (trial_days in (3, 7)),
  add column extension_approved_until timestamptz,
  add column extension_redeemed_at timestamptz;

create or replace function public.claim_bento_trial(
  p_auth_user_id uuid, p_workspace_id uuid, p_subscription_id text,
  p_trial_ends_at timestamptz, p_checkout_key uuid
) returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_trial public.bento_trial_owners; v_days integer;
begin
  if p_workspace_id <> p_auth_user_id then
    raise exception 'Trials are available only for the initial workspace.';
  end if;
  select trial_days into v_days from public.bento_trial_checkouts
    where auth_user_id=p_auth_user_id and workspace_id=p_workspace_id
      and checkout_key=p_checkout_key;
  if v_days is null then raise exception 'Trial checkout authorization could not be verified.'; end if;
  if not exists (select 1 from public.workspace_memberships
    where auth_user_id=p_auth_user_id and workspace_id=p_workspace_id
      and role='owner' and status='active') then
    raise exception 'Trial workspace ownership could not be verified.';
  end if;
  insert into public.bento_trial_owners(auth_user_id,workspace_id,subscription_id,trial_ends_at,trial_days)
    values(p_auth_user_id,p_workspace_id,p_subscription_id,p_trial_ends_at,v_days)
    on conflict(auth_user_id) do nothing;
  select * into v_trial from public.bento_trial_owners
    where auth_user_id=p_auth_user_id for update;
  if v_trial.workspace_id <> p_workspace_id or v_trial.subscription_id <> p_subscription_id
    or v_trial.trial_days <> v_days then
    raise exception 'This owner has already used their trial.';
  end if;
  if p_trial_ends_at > v_trial.trial_ends_at then
    if v_trial.extension_approved_until is null
      or p_trial_ends_at > v_trial.extension_approved_until then
      raise exception 'Trial extension was not authorized.';
    end if;
    update public.bento_trial_owners set trial_ends_at=p_trial_ends_at
      where auth_user_id=p_auth_user_id;
    return p_trial_ends_at;
  end if;
  -- An older provider webhook must not shorten a verified extension.
  return v_trial.trial_ends_at;
end; $$;

-- Attempts and outcomes are server-only. One first substantive attempt per
-- owner and per Dodo customer prevents offer shopping across workspaces.
create table public.cancellation_intents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id text not null,
  customer_id text,
  first_attempt boolean not null,
  reason text,
  details text,
  switch_destination text,
  switch_why text,
  offer_type text,
  offer_shown_at timestamptz,
  offer_accepted_at timestamptz,
  cancellation_confirmed_at timestamptz,
  renewal_resumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cancellation_intents_details_length check (length(coalesce(details,'')) <= 500),
  constraint cancellation_intents_reason_check check (reason is null or reason in
    ('budget','break','missing_capability','product_problem','moving_elsewhere')),
  constraint cancellation_intents_offer_check check (offer_type is null or offer_type in
    ('pause','trial_extension','discount','downgrade','support'))
);
create unique index cancellation_first_owner on public.cancellation_intents(owner_id)
  where first_attempt;
create unique index cancellation_first_customer on public.cancellation_intents(customer_id)
  where first_attempt and customer_id is not null;
create index cancellation_intents_created_at on public.cancellation_intents(created_at desc);
create index cancellation_intents_subscription on public.cancellation_intents(subscription_id, created_at desc);
create trigger cancellation_intents_updated_at before update on public.cancellation_intents
  for each row execute function public.tg_set_updated_at();
alter table public.cancellation_intents enable row level security;
revoke all on public.cancellation_intents from public,anon,authenticated;
grant all on public.cancellation_intents to service_role;

create table public.subscription_pauses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id text not null,
  started_at timestamptz not null default now(),
  resume_at timestamptz not null,
  next_attempt_at timestamptz not null,
  resumed_at timestamptz,
  resume_attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_pauses_duration check (resume_at > started_at and resume_at <= started_at + interval '90 days')
);
create unique index subscription_pauses_one_active on public.subscription_pauses(workspace_id)
  where resumed_at is null;
create index subscription_pauses_due on public.subscription_pauses(next_attempt_at)
  where resumed_at is null;
create trigger subscription_pauses_updated_at before update on public.subscription_pauses
  for each row execute function public.tg_set_updated_at();
alter table public.subscription_pauses enable row level security;
revoke all on public.subscription_pauses from public,anon,authenticated;
grant all on public.subscription_pauses to service_role;

-- A deliberate pause stops hosted access without starting the 90-day deletion
-- lifecycle. Resume clears this episode; a later real cancellation starts its
-- own retention clock.
create or replace function public.reconcile_workspace_billing_lifecycle(
  p_workspace_id uuid, p_subscription_id text, p_reason text, p_plan text,
  p_stopped_at timestamptz, p_last_paid_at timestamptz
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
  if p_reason not in ('past_due','canceled','expired','paused') or p_stopped_at is null
    or p_plan not in ('store','creator','creator_plus') or nullif(p_subscription_id,'') is null then
    raise exception 'Invalid billing lifecycle.';
  end if;
  if p_reason='paused' then
    result:=jsonb_build_object(
      'episodeId',case when prior->>'reason'='paused' and prior->>'subscriptionId'=p_subscription_id
        then prior->>'episodeId' else gen_random_uuid()::text end,
      'subscriptionId',p_subscription_id,'reason','paused','plan',p_plan,
      'stoppedAt',p_stopped_at,'toolsStopAt',p_stopped_at,
      'publicStopAt',p_stopped_at,'deleteAfter',null,'deletingAt',null
    );
    update public.profiles set billing_lifecycle=result where id=p_workspace_id;
    return result;
  end if;
  stopped:=p_stopped_at;
  reason:=p_reason;
  if prior->>'reason'<>'paused' and prior->>'subscriptionId'=p_subscription_id
    and p_last_paid_at>(prior->>'stoppedAt')::timestamptz then prior:=null; end if;
  if prior->>'reason'<>'paused' and prior->>'subscriptionId'=p_subscription_id
    and (prior->>'stoppedAt')::timestamptz<=now() then
    stopped:=least(stopped,(prior->>'stoppedAt')::timestamptz);
    if prior->>'reason'='past_due' then reason:='past_due'; end if;
  end if;
  result:=jsonb_build_object(
    'episodeId',case when prior->>'reason'<>'paused' and prior->>'subscriptionId'=p_subscription_id
      then prior->>'episodeId' else gen_random_uuid()::text end,
    'subscriptionId',p_subscription_id,'reason',reason,'plan',p_plan,'stoppedAt',stopped,
    'toolsStopAt',stopped + case when reason='past_due' then interval '3 days' else interval '0' end,
    'publicStopAt',stopped + case when reason='past_due' then interval '7 days' else interval '0' end,
    'deleteAfter',greatest(stopped + interval '90 days',
      coalesce((prior->>'deleteAfter')::timestamptz,stopped + interval '90 days')),
    'deletingAt',null
  );
  update public.profiles set billing_lifecycle=result where id=p_workspace_id;
  return result;
end; $$;
notify pgrst,'reload schema';
