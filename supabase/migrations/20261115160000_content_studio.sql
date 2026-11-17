create table public.content_studio_entries (
  id uuid primary key,
  workspace_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('project', 'preset')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  revision integer not null check (revision > 0),
  document jsonb not null check (
    jsonb_typeof(document) = 'object'
    and document ? 'schemaVersion'
    and document->'schemaVersion' = '1'::jsonb
    and document ? 'format'
    and document->>'format' in ('carousel', 'reel')
    and octet_length(document::text) <= 65536
  ),
  updated_at timestamptz not null default now()
);

create index content_studio_entries_workspace_recent
  on public.content_studio_entries(workspace_id, updated_at desc, id);

alter table public.content_studio_entries enable row level security;
revoke all on table public.content_studio_entries from public, anon, authenticated;
grant select, insert, update, delete on table public.content_studio_entries to service_role;

create function public.save_content_studio_entry(
  p_workspace_id uuid, p_id uuid, p_kind text, p_title text, p_revision integer, p_document jsonb
) returns integer language plpgsql security invoker set search_path = '' as $$
declare
  next_revision integer;
begin
  if p_revision = 0 then
    perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 6544));
    select e.revision into next_revision
    from public.content_studio_entries e
    where e.workspace_id = p_workspace_id and e.id = p_id
      and e.revision = 1 and e.kind = p_kind
      and e.title = p_title and e.document = p_document;
    if found then return next_revision; end if;

    if (select count(*) from public.content_studio_entries e where e.workspace_id = p_workspace_id) >= 100 then
      raise exception 'Studio project and preset limit reached.';
    end if;

    insert into public.content_studio_entries (id, workspace_id, kind, title, revision, document)
    values (p_id, p_workspace_id, p_kind, p_title, 1, p_document)
    on conflict (id) do nothing
    returning revision into next_revision;
  else
    update public.content_studio_entries e
    set title = p_title, revision = e.revision + 1, document = p_document, updated_at = now()
    where e.workspace_id = p_workspace_id and e.id = p_id and e.kind = p_kind
      and e.revision = p_revision and e.document->>'format' = p_document->>'format'
    returning e.revision into next_revision;

    if not found then
      select e.revision into next_revision
      from public.content_studio_entries e
      where e.workspace_id = p_workspace_id and e.id = p_id and e.kind = p_kind
        and e.revision = p_revision + 1 and e.title = p_title and e.document = p_document;
    end if;
  end if;
  return next_revision;
end;
$$;
revoke all on function public.save_content_studio_entry(uuid, uuid, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_content_studio_entry(uuid, uuid, text, text, integer, jsonb)
  to service_role;
