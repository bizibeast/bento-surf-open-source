-- Shared provider credentials require explicit tenant asset grants and atomic managed reservations.
alter table public.heygen_generation_jobs
  alter column connection_id drop not null,
  add column billing_mode text not null default 'byok' check (billing_mode in ('byok','managed')),
  add column output_kind text not null default 'video' check (output_kind in ('video','audio')),
  add column source_audio_job_id uuid,
  add column provider_audio_url text check (length(provider_audio_url) <= 4096),
  add column speech_words jsonb not null default '[]' check (jsonb_typeof(speech_words) = 'array' and octet_length(speech_words::text) <= 131072),
  add column usage_reservation_id uuid references public.managed_provider_spend_reservations(id),
  add column estimated_microusd bigint check (estimated_microusd between 1 and 1000000),
  add constraint heygen_job_funding_connection check ((billing_mode = 'managed') = (connection_id is null)),
  add constraint heygen_job_workspace foreign key (workspace_id) references public.profiles(id) on delete cascade,
  add constraint heygen_job_requester foreign key (auth_user_id) references auth.users(id) on delete cascade;
alter table public.heygen_generation_jobs add constraint heygen_job_scoped_id unique(id,workspace_id,auth_user_id);
alter table public.heygen_generation_jobs add constraint heygen_source_scope
  foreign key(source_audio_job_id,workspace_id,auth_user_id) references public.heygen_generation_jobs(id,workspace_id,auth_user_id);
alter table public.heygen_generation_jobs add constraint heygen_audio_source_kind
  check(source_audio_job_id is null or (output_kind = 'video' and source_audio_job_id <> id));

create table public.managed_heygen_assets (
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  asset_type text not null check (asset_type in ('avatar','voice')),
  provider_asset_id text not null check (provider_asset_id ~ '^[a-zA-Z0-9_-]{1,160}$'),
  consent_verified_at timestamptz not null,
  active boolean not null default true,
  primary key (workspace_id, asset_type, provider_asset_id)
);
alter table public.managed_heygen_assets enable row level security;
revoke all on public.managed_heygen_assets from public, anon, authenticated;
grant select, insert, update, delete on public.managed_heygen_assets to service_role;

alter table public.managed_provider_spend_policy
  alter column monthly_microusd set default 25000000,
  alter column weekly_microusd set default 6250000;
update public.managed_provider_spend_policy set monthly_microusd = least(monthly_microusd,25000000),
  weekly_microusd = least(weekly_microusd,6250000);
alter table public.managed_provider_spend_policy add constraint managed_monthly_hard_ceiling check (monthly_microusd <= 25000000);

alter table public.content_studio_entries add constraint studio_entry_workspace_key unique(id,workspace_id);
create table public.studio_reel_productions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null references public.content_studio_entries(id) on delete cascade,
  entry_revision integer not null check (entry_revision > 0),
  request_id uuid not null,
  document jsonb not null check (document->>'format' = 'reel' and octet_length(document::text) <= 65536),
  publication jsonb check (publication is null or (jsonb_typeof(publication) = 'object' and octet_length(publication::text) <= 65536)),
  state jsonb not null default '{}' check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 131072),
  title text not null,
  status text not null default 'awaiting_approval' check (status in ('awaiting_approval','queued','narrating','avatars','rendering','ready','failed','cancelled','needs_revision')),
  estimated_microusd bigint not null check (estimated_microusd between 1 and 25000000),
  estimated_avatar_seconds integer not null check (estimated_avatar_seconds between 0 and 90),
  media_ids uuid[] not null default '{}',
  approved_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  steps integer not null default 0 check (steps between 0 and 300),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,auth_user_id,request_id),
  foreign key(entry_id,workspace_id) references public.content_studio_entries(id,workspace_id) on delete cascade,
  check ((status = 'awaiting_approval') or status = 'cancelled' or approved_at is not null)
);
create index studio_reel_production_due on public.studio_reel_productions(next_attempt_at)
  where status in ('queued','narrating','avatars','rendering');
create index studio_reel_production_workspace on public.studio_reel_productions(workspace_id, auth_user_id, created_at desc);
create unique index studio_reel_production_one_active on public.studio_reel_productions(workspace_id)
  where status in ('queued','narrating','avatars','rendering');
alter table public.studio_reel_productions enable row level security;
revoke all on public.studio_reel_productions from public, anon, authenticated;
grant select, insert, update, delete on public.studio_reel_productions to service_role;

alter table public.studio_carousel_render_jobs add column max_attempt_microusd bigint
  check (max_attempt_microusd between 1 and 1000000);
alter table public.studio_carousel_render_jobs add column production_id uuid references public.studio_reel_productions(id) on delete cascade,
  add column private_output boolean not null default false,
  add constraint managed_render_is_private check (production_id is null or private_output);
update public.provider_budget_policies set workspace_daily_limit = 1800000,
  workspace_monthly_limit = 54000000 where resource = 'studio_reel_browser_milliseconds';

-- Snapshot the approved render price in the same transaction as job creation.
create function public.queue_studio_reel_production_render(p_production_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare production public.studio_reel_productions; job_id uuid; cap bigint;
begin
  perform pg_advisory_xact_lock(28117950566);
  select * into production from public.studio_reel_productions where id = p_production_id for update;
  if not found or production.status <> 'rendering' or production.approved_at is null then return null; end if;
  cap := (production.state->>'renderCost')::bigint;
  if cap is null or cap not between 1 and 1000000 then return null; end if;
  select id into job_id from public.studio_carousel_render_jobs
    where entry_id = production.entry_id and revision = (production.state->>'renderRevision')::integer
      and workspace_id = production.workspace_id and requested_by = production.auth_user_id
      and production_id = production.id and private_output;
  if found then return job_id; end if;
  if (select count(*) from public.studio_carousel_render_jobs where created_at >= now() - interval '24 hours') >= 100
    or (select count(*) from public.studio_carousel_render_jobs where workspace_id = production.workspace_id and created_at >= now() - interval '24 hours') >= 3 then return null; end if;
  insert into public.studio_carousel_render_jobs(workspace_id, entry_id, revision, title, document, requested_by, max_attempt_microusd, production_id,private_output)
    select e.workspace_id,e.id,e.revision,e.title,e.document,production.auth_user_id,cap,production.id,true
    from public.content_studio_entries e where e.workspace_id = production.workspace_id and e.id = production.entry_id
      and e.revision = (production.state->>'renderRevision')::integer and e.document = production.state->'completedDocument'
    on conflict(entry_id, revision) do nothing returning id into job_id;
  return job_id;
end;
$$;
revoke all on function public.queue_studio_reel_production_render(uuid) from public, anon, authenticated;
grant execute on function public.queue_studio_reel_production_render(uuid) to service_role;

-- Managed narration adds voice-only requests; dollar reservations remain the hard spending boundary.
create or replace function public.reserve_external_tool_call(
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
        case when p_action = 'submit' then case when exists (select 1 from public.heygen_generation_jobs j where j.id = p_job_id and j.workspace_id = p_workspace_id and j.auth_user_id = p_auth_user_id and j.billing_mode = 'managed') then 60 else 10 end else 30 end)
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
