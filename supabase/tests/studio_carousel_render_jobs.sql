begin;

insert into public.profiles (id, username) values
  ('16100000-0000-4000-8000-000000000001', 'studio_render_fixture_a'),
  ('16100000-0000-4000-8000-000000000002', 'studio_render_fixture_b');

set local role service_role;
do $$
declare
  a uuid := '16100000-0000-4000-8000-000000000001';
  b uuid := '16100000-0000-4000-8000-000000000002';
  item uuid := '16100000-0000-4000-8000-000000000003';
  doc jsonb := '{"format":"carousel","schemaVersion":1}';
  first_job uuid;
begin
  insert into public.content_studio_entries (id, workspace_id, kind, title, revision, document)
    values (item, a, 'project', 'Carousel export', 1, doc);
  if public.queue_studio_carousel_render(b, item, 1) is not null then
    raise exception 'Cross-workspace render accepted';
  end if;
  first_job := public.queue_studio_carousel_render(a, item, 1);
  if first_job is null or public.queue_studio_carousel_render(a, item, 1) is distinct from first_job then
    raise exception 'Render submission was not idempotent';
  end if;
  for target_revision in 2..3 loop
    update public.content_studio_entries set revision = target_revision where id = item;
    if public.queue_studio_carousel_render(a, item, target_revision) is null then
      raise exception 'Render below the cap was denied';
    end if;
  end loop;
  update public.content_studio_entries set revision = 4 where id = item;
  if public.queue_studio_carousel_render(a, item, 4) is not null then
    raise exception 'Workspace render cap was not enforced';
  end if;
  if (select document from public.studio_carousel_render_jobs where id = first_job) is distinct from doc then
    raise exception 'The saved render snapshot changed';
  end if;
end $$;

reset role;
insert into auth.users(id,email) values
  ('16100000-0000-4000-8000-000000000004', 'studio-reel-a@bento.invalid'),
  ('16100000-0000-4000-8000-000000000005', 'studio-reel-b@bento.invalid');

set local role service_role;
do $$
declare
  a uuid := '16100000-0000-4000-8000-000000000004';
  b uuid := '16100000-0000-4000-8000-000000000005';
  item uuid := '16100000-0000-4000-8000-000000000006';
  reel_job uuid;
begin
  insert into public.content_studio_entries(id,workspace_id,kind,title,revision,document)
    values (item,a,'project','Reel export',1,'{"format":"reel","schemaVersion":1}');
  if public.queue_studio_carousel_render(a,item,1) is not null then
    raise exception 'Carousel RPC queued a Reel';
  end if;
  if public.queue_studio_reel_render(b,item,1,b) is not null then
    raise exception 'Reel RPC accepted a project from another workspace';
  end if;
  reel_job := public.queue_studio_reel_render(a,item,1,a);
  if reel_job is null or public.queue_studio_reel_render(a,item,1,a) is distinct from reel_job then
    raise exception 'Reel submission was not idempotent';
  end if;
  if public.queue_studio_reel_render(a,item,1,b) is not null then
    raise exception 'Another member could read an existing request';
  end if;
  if (select requested_by from public.studio_carousel_render_jobs where id = reel_job) is distinct from a then
    raise exception 'The Reel requester was not retained';
  end if;
end $$;

reset role;
set local role authenticated;
do $$
begin
  begin
    perform 1 from public.studio_carousel_render_jobs;
    raise exception 'Authenticated users cannot read render snapshots directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.queue_studio_reel_render(null,null,null,null);
    raise exception 'Authenticated users cannot queue a Reel directly';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
