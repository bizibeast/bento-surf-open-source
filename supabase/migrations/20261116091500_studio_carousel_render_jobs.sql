create table public.studio_carousel_render_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  entry_id uuid not null references public.content_studio_entries(id) on delete cascade,
  revision integer not null check (revision > 0),
  title text not null check (length(title) between 1 and 120),
  document jsonb not null check (document->>'format' = 'carousel' and octet_length(document::text) <= 65536),
  status text not null default 'queued' check (status in ('queued', 'rendering', 'ready', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 2),
  lease_id uuid,
  lease_expires_at timestamptz,
  media_ids uuid[] not null default '{}' check (cardinality(media_ids) <= 10),
  created_at timestamptz not null default now(),
  unique (entry_id, revision)
);

create index studio_carousel_render_workspace_created_idx
  on public.studio_carousel_render_jobs(workspace_id, created_at desc);
create index studio_carousel_render_created_idx on public.studio_carousel_render_jobs(created_at desc);
alter table public.studio_carousel_render_jobs enable row level security;
revoke all on table public.studio_carousel_render_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.studio_carousel_render_jobs to service_role;

create function public.queue_studio_carousel_render(p_workspace_id uuid, p_entry_id uuid, p_revision integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare job_id uuid;
begin
  perform pg_advisory_xact_lock(28117950566);
  select j.id into job_id from public.studio_carousel_render_jobs j
    where j.workspace_id = p_workspace_id and j.entry_id = p_entry_id and j.revision = p_revision;
  if found then return job_id; end if;

  if (select count(*) from public.studio_carousel_render_jobs j where j.created_at >= now() - interval '24 hours') >= 100
    or (select count(*) from public.studio_carousel_render_jobs j where j.workspace_id = p_workspace_id and j.created_at >= now() - interval '24 hours') >= 3 then
    return null;
  end if;

  insert into public.studio_carousel_render_jobs(workspace_id, entry_id, revision, title, document)
    select e.workspace_id, e.id, e.revision, e.title, e.document
    from public.content_studio_entries e
    where e.workspace_id = p_workspace_id and e.id = p_entry_id and e.revision = p_revision
      and e.kind = 'project' and e.document->>'format' = 'carousel'
    returning id into job_id;
  return job_id;
end;
$$;
revoke all on function public.queue_studio_carousel_render(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.queue_studio_carousel_render(uuid, uuid, integer) to service_role;
