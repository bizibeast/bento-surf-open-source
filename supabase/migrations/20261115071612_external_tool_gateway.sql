create table public.external_tool_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('heygen', 'github_mcp')),
  credential_encrypted text,
  revision uuid not null default gen_random_uuid(),
  capabilities text[] not null default '{}',
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, auth_user_id, provider),
  unique (id, workspace_id, auth_user_id),
  check ((revoked_at is null) = (credential_encrypted is not null))
);

create table public.heygen_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  auth_user_id uuid not null,
  connection_id uuid not null,
  connection_revision uuid not null,
  client_id text not null,
  request_key text not null,
  avatar_id text not null,
  avatar_name text not null,
  voice_id text not null,
  voice_name text not null,
  script text not null check (char_length(script) between 1 and 600),
  requested_seconds integer not null check (requested_seconds between 1 and 60),
  estimated_usd_per_minute numeric(6, 2) not null check (estimated_usd_per_minute > 0),
  status text not null default 'awaiting_approval' check (status in (
    'awaiting_approval', 'approved', 'submitting', 'queued', 'processing', 'ready',
    'failed', 'submission_unknown', 'revoked', 'expired', 'asset_unavailable'
  )),
  approved_at timestamptz,
  submitted_at timestamptz,
  provider_video_id text,
  duration_seconds double precision,
  asset_key text,
  error_code text,
  refresh_after timestamptz,
  asset_attempts smallint not null default 0 check (asset_attempts between 0 and 3),
  created_at timestamptz not null default now(),
  foreign key (connection_id, workspace_id, auth_user_id)
    references public.external_tool_connections(id, workspace_id, auth_user_id) on delete cascade,
  unique (workspace_id, auth_user_id, client_id, request_key),
  check ((status = 'ready') = (asset_key is not null))
);

create index heygen_generation_jobs_member_created_idx
  on public.heygen_generation_jobs (workspace_id, auth_user_id, created_at desc);

create table public.external_tool_audit (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('heygen', 'github_mcp')),
  action text not null check (action in (
    'connect', 'disconnect', 'discover', 'account', 'catalog', 'prepare', 'approve', 'submit', 'poll'
  )),
  job_id uuid,
  outcome text not null default 'started' check (outcome in ('started', 'succeeded', 'failed')),
  created_at timestamptz not null default now()
);

create index external_tool_audit_workspace_created_idx
  on public.external_tool_audit (workspace_id, created_at desc);

alter table public.external_tool_connections enable row level security;
alter table public.heygen_generation_jobs enable row level security;
alter table public.external_tool_audit enable row level security;

revoke all on public.external_tool_connections, public.heygen_generation_jobs,
  public.external_tool_audit from public, anon, authenticated;
grant select, insert, update, delete on public.external_tool_connections,
  public.heygen_generation_jobs, public.external_tool_audit to service_role;

-- Serialize reservations per workspace, including calls from different members and Workers.
create function public.reserve_external_tool_call(
  p_workspace_id uuid, p_auth_user_id uuid, p_provider text, p_action text, p_job_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('external_tool_gateway:' || p_workspace_id::text, 0)
  );
  if not exists (
    select 1 from public.workspace_memberships m
    join public.profiles p on p.id = m.workspace_id
    where m.workspace_id = p_workspace_id and m.auth_user_id = p_auth_user_id
      and m.status = 'active' and m.role = 'owner' and p.workspace_status = 'active'
  ) then
    return null;
  end if;
  if p_action <> 'disconnect' and (
    (select count(*) from public.external_tool_audit a
      where a.workspace_id = p_workspace_id and a.created_at >= v_now - interval '1 minute') >= 40
    or (p_action in ('prepare', 'submit') and
      (select count(*) from public.external_tool_audit a
        where a.workspace_id = p_workspace_id and a.action = p_action
          and a.created_at >= v_now - interval '24 hours') >=
        case when p_action = 'submit' then 10 else 30 end)
  ) then
    return null;
  end if;
  insert into public.external_tool_audit (workspace_id, auth_user_id, provider, action, job_id)
  values (p_workspace_id, p_auth_user_id, p_provider, p_action, p_job_id)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.reserve_external_tool_call(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_external_tool_call(uuid, uuid, text, text, uuid)
  to service_role;
