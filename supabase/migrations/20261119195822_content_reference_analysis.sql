-- Private, bounded reference jobs. No raw source footage is added to publishable Media.
create table public.content_reference_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  input jsonb not null check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 8192),
  status text not null default 'queued' check (status in ('queued','processing','ready','failed')),
  evidence jsonb check (evidence is null or (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 131072)),
  has_grid boolean not null default false,
  cleaned_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 1),
  lease_id uuid,
  lease_expires_at timestamptz,
  error_message text check (length(error_message) <= 500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  unique(workspace_id,auth_user_id,request_id)
);
create index content_reference_workspace_created on public.content_reference_jobs(workspace_id,created_at desc);
create index content_reference_created on public.content_reference_jobs(created_at);
create index content_reference_requester on public.content_reference_jobs(auth_user_id);
create index content_reference_expiry on public.content_reference_jobs(expires_at) where cleaned_at is null;
create unique index content_reference_one_active on public.content_reference_jobs(workspace_id) where status in ('queued','processing');
alter table public.content_reference_jobs enable row level security;
revoke all on public.content_reference_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.content_reference_jobs to service_role;

create function public.queue_content_reference(p_workspace_id uuid,p_auth_user_id uuid,p_request_id uuid,p_input jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare job_id uuid;
begin
  -- One lock coordinates global caps, per-workspace concurrency and idempotency across Workers.
  perform pg_catalog.pg_advisory_xact_lock(28117950567);
  if not exists(select 1 from public.workspace_memberships m join public.profiles p on p.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.auth_user_id=p_auth_user_id and m.role='owner' and m.status='active' and p.workspace_status='active') then return null; end if;
  select id into job_id from public.content_reference_jobs where workspace_id=p_workspace_id
    and auth_user_id=p_auth_user_id and request_id=p_request_id and input=p_input and expires_at>now();
  if found then return job_id; end if;
  if exists(select 1 from public.content_reference_jobs where workspace_id=p_workspace_id and status in ('queued','processing'))
    or (select count(*) from public.content_reference_jobs where created_at>=now()-interval '24 hours')>=100
    or (select count(*) from public.content_reference_jobs where created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')>=2000
    or (select count(*) from public.content_reference_jobs where workspace_id=p_workspace_id and created_at>=now()-interval '24 hours')>=5
    or (select count(*) from public.content_reference_jobs where workspace_id=p_workspace_id and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')>=30 then return null; end if;
  insert into public.content_reference_jobs(workspace_id,auth_user_id,request_id,input)
    values(p_workspace_id,p_auth_user_id,p_request_id,p_input) on conflict(workspace_id,auth_user_id,request_id) do nothing returning id into job_id;
  return job_id;
end;
$$;
revoke all on function public.queue_content_reference(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.queue_content_reference(uuid,uuid,uuid,jsonb) to service_role;

-- Durable creation receipts prevent MCP/network replays from buying another AI completion.
alter table public.content_reference_jobs add constraint content_reference_scoped_id unique(id,workspace_id,auth_user_id);
create table public.content_reference_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  analysis_id uuid not null,
  input jsonb not null check (octet_length(input::text)<=65536),
  output jsonb check (output is null or octet_length(output::text)<=65536),
  status text not null default 'generating' check (status in ('generating','generated','ready','failed')),
  created_at timestamptz not null default now(),
  unique(workspace_id,auth_user_id,request_id),
  foreign key(analysis_id,workspace_id,auth_user_id) references public.content_reference_jobs(id,workspace_id,auth_user_id) on delete no action
);
create index content_reference_drafts_created on public.content_reference_drafts(created_at);
create index content_reference_drafts_workspace_created on public.content_reference_drafts(workspace_id,created_at);
create index content_reference_drafts_requester on public.content_reference_drafts(auth_user_id);
create index content_reference_drafts_analysis on public.content_reference_drafts(analysis_id,workspace_id,auth_user_id);
alter table public.content_reference_drafts enable row level security;
revoke all on public.content_reference_drafts from public,anon,authenticated;
grant select,insert,update,delete on public.content_reference_drafts to service_role;
create function public.claim_content_reference_draft(p_workspace_id uuid,p_auth_user_id uuid,p_request_id uuid,p_analysis_id uuid,p_input jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare receipt_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(28117950567);
  if not exists(select 1 from public.workspace_memberships m join public.profiles p on p.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.auth_user_id=p_auth_user_id and m.role='owner' and m.status='active' and p.workspace_status='active')
    or not exists(select 1 from public.content_reference_jobs where id=p_analysis_id and workspace_id=p_workspace_id and auth_user_id=p_auth_user_id and status='ready' and expires_at>now()) then return null; end if;
  -- Existing receipts are read by the application. Returning null never licenses a second completion.
  if exists(select 1 from public.content_reference_drafts where workspace_id=p_workspace_id and auth_user_id=p_auth_user_id and request_id=p_request_id)
    or (select count(*) from public.content_reference_drafts where created_at>=now()-interval '24 hours')>=100
    or (select count(*) from public.content_reference_drafts where workspace_id=p_workspace_id and created_at>=now()-interval '24 hours')>=5
    or (select count(*) from public.content_reference_drafts where workspace_id=p_workspace_id and created_at>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')>=30 then return null; end if;
  insert into public.content_reference_drafts(workspace_id,auth_user_id,request_id,analysis_id,input)
    values(p_workspace_id,p_auth_user_id,p_request_id,p_analysis_id,p_input) returning id into receipt_id;
  return receipt_id;
end;
$$;
revoke all on function public.claim_content_reference_draft(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_content_reference_draft(uuid,uuid,uuid,uuid,jsonb) to service_role;

create function public.purge_content_reference_receipts()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  -- Coordinate retention with claim/queue, and keep each receipt through its own quota window.
  perform pg_catalog.pg_advisory_xact_lock(28117950567);
  delete from public.content_reference_drafts where id in (
    select d.id from public.content_reference_drafts d
    where d.created_at < now() - interval '35 days'
    order by d.created_at limit 200
  );
  delete from public.content_reference_jobs where id in (
    select j.id from public.content_reference_jobs j
    where j.created_at < now() - interval '35 days' and j.cleaned_at is not null
      and not exists(select 1 from public.content_reference_drafts d
        where d.analysis_id=j.id and d.workspace_id=j.workspace_id and d.auth_user_id=j.auth_user_id)
    order by j.created_at limit 200
  );
end;
$$;
revoke all on function public.purge_content_reference_receipts() from public,anon,authenticated;
grant execute on function public.purge_content_reference_receipts() to service_role;
