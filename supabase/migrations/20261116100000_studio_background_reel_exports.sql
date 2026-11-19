insert into public.provider_budget_policies
  values ('studio_reel_browser_milliseconds', true, 3600000, 108000000, 120000, 600000);

alter table public.studio_carousel_render_jobs
  add column requested_by uuid references auth.users(id) on delete set null,
  drop constraint studio_carousel_render_jobs_document_check,
  add constraint studio_render_jobs_supported_document
    check (document->>'format' in ('carousel', 'reel') and octet_length(document::text) <= 65536);

create function public.queue_studio_reel_render(
  p_workspace_id uuid, p_entry_id uuid, p_revision integer, p_auth_user_id uuid
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare job_id uuid;
begin
  perform pg_advisory_xact_lock(28117950566);
  select j.id into job_id from public.studio_carousel_render_jobs j
    where j.workspace_id = p_workspace_id and j.entry_id = p_entry_id and j.revision = p_revision
      and j.document->>'format' = 'reel' and j.requested_by = p_auth_user_id;
  if found then return job_id; end if;

  if p_auth_user_id is null
    or (select count(*) from public.studio_carousel_render_jobs j where j.created_at >= now() - interval '24 hours') >= 100
    or (select count(*) from public.studio_carousel_render_jobs j where j.workspace_id = p_workspace_id and j.created_at >= now() - interval '24 hours') >= 3 then
    return null;
  end if;

  insert into public.studio_carousel_render_jobs(workspace_id, entry_id, revision, title, document, requested_by)
    select e.workspace_id, e.id, e.revision, e.title, e.document, p_auth_user_id
    from public.content_studio_entries e
    where e.workspace_id = p_workspace_id and e.id = p_entry_id and e.revision = p_revision
      and e.kind = 'project' and e.document->>'format' = 'reel'
    on conflict (entry_id, revision) do nothing
    returning id into job_id;
  return job_id;
end;
$$;
revoke all on function public.queue_studio_reel_render(uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.queue_studio_reel_render(uuid, uuid, integer, uuid) to service_role;
