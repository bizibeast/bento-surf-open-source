begin;
do $$
declare
  owner_id uuid := 'a1000000-0000-4000-8000-000000000001';
  workspace_a uuid := 'a2000000-0000-4000-8000-000000000001';
  workspace_b uuid := 'a2000000-0000-4000-8000-000000000002';
  entry_a uuid := 'b1000000-0000-4000-8000-000000000001';
  production_a uuid := 'b2000000-0000-4000-8000-000000000001';
  audio_a uuid := 'b3000000-0000-4000-8000-000000000001';
  render_a uuid;
  reel_document jsonb := '{"schemaVersion":1,"format":"reel","scenes":[]}'::jsonb;
  table_name text;
begin
  foreach table_name in array array['studio_reel_productions','managed_heygen_assets'] loop
    if has_table_privilege('anon','public.' || table_name,'select') or
      has_table_privilege('authenticated','public.' || table_name,'select') or
      not (select relrowsecurity from pg_class where oid=('public.' || table_name)::regclass) then
      raise exception 'untrusted access to %',table_name;
    end if;
  end loop;
  if has_function_privilege('anon','public.queue_studio_reel_production_render(uuid)','execute') or
    has_function_privilege('authenticated','public.queue_studio_reel_production_render(uuid)','execute') then raise exception 'public render execution'; end if;
  begin
    update public.managed_provider_spend_policy set monthly_microusd=25000001;
    raise exception 'hard managed ceiling not enforced';
  exception when check_violation then null; end;
  insert into public.content_studio_entries values(entry_a,workspace_a,'project','Test Reel',1,reel_document,now());
  insert into public.studio_reel_productions(id,workspace_id,auth_user_id,entry_id,entry_revision,request_id,document,title,estimated_microusd,estimated_avatar_seconds)
    values(production_a,workspace_a,owner_id,entry_a,1,gen_random_uuid(),reel_document,'Test Reel',500000,15);
  if public.queue_studio_reel_production_render(production_a) is not null then raise exception 'render before approval'; end if;
  begin
    insert into public.studio_reel_productions(workspace_id,auth_user_id,entry_id,entry_revision,request_id,document,title,estimated_microusd,estimated_avatar_seconds)
      values(workspace_b,owner_id,entry_a,1,gen_random_uuid(),reel_document,'Cross tenant',500000,15);
    raise exception 'cross tenant project accepted';
  exception when foreign_key_violation then null; end;
  update public.studio_reel_productions set status='rendering',approved_at=now(),
    state=jsonb_build_object('renderRevision',1,'renderCost',50000,'completedDocument',reel_document)
    where id=production_a;
  begin
    insert into public.studio_reel_productions(workspace_id,auth_user_id,entry_id,entry_revision,request_id,document,title,status,approved_at,estimated_microusd,estimated_avatar_seconds)
      values(workspace_a,owner_id,entry_a,1,gen_random_uuid(),reel_document,'Concurrent','queued',now(),500000,15);
    raise exception 'concurrent production accepted';
  exception when unique_violation then null; end;
  render_a := public.queue_studio_reel_production_render(production_a);
  if render_a is null or public.queue_studio_reel_production_render(production_a) <> render_a then raise exception 'render dispatch not idempotent'; end if;
  if not exists(select 1 from public.studio_carousel_render_jobs where id=render_a and production_id=production_a and max_attempt_microusd=50000 and requested_by=owner_id) then raise exception 'render receipt lost'; end if;
  insert into public.heygen_generation_jobs(id,workspace_id,auth_user_id,connection_revision,client_id,request_key,avatar_id,avatar_name,voice_id,voice_name,script,requested_seconds,estimated_usd_per_minute,billing_mode,output_kind)
    values(audio_a,workspace_a,owner_id,gen_random_uuid(),'bento-browser',gen_random_uuid(),'voiceover','Narration','voice','Voice','Test',8,.01,'managed','audio');
  begin
    insert into public.heygen_generation_jobs(workspace_id,auth_user_id,connection_revision,client_id,request_key,avatar_id,avatar_name,voice_id,voice_name,script,requested_seconds,estimated_usd_per_minute,billing_mode,source_audio_job_id)
      values(workspace_b,owner_id,gen_random_uuid(),'bento-browser',gen_random_uuid(),'avatar','Avatar','voice','Voice','Test',8,2.31,'managed',audio_a);
    raise exception 'cross tenant audio accepted';
  exception when foreign_key_violation then null; end;
end $$;
rollback;
