-- Run with psql -v ON_ERROR_STOP=1 in an EMPTY disposable local database.
-- Synthetic fixtures only. Schema, migration and fixtures roll back.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table social_posts(id uuid primary key,user_id uuid,status text,scheduled_at timestamptz,cancelled_at timestamptz,created_at timestamptz default now());
create table social_connections(id uuid primary key,user_id uuid,provider text,status text,reauth_required boolean default false,scopes text[] default '{}');
create table social_post_targets(id uuid primary key,post_id uuid references social_posts,connection_id uuid references social_connections,provider text,status text,attempt_count int default 1,next_attempt_at timestamptz,lease_expires_at timestamptz,idempotency_key uuid default gen_random_uuid(),last_error_code text,last_error_message text,retry_started_at timestamptz,remote_post_id text,remote_post_url text,published_at timestamptz,upload_session_url text,upload_byte_offset bigint default 0,created_at timestamptz default now(),updated_at timestamptz default now());
create table social_publish_attempts(target_id uuid references social_post_targets,outcome text,created_at timestamptz default now());
create table social_outbox_events(id uuid default gen_random_uuid(),target_id uuid,event_type text,idempotency_key uuid,provider text,payload jsonb,status text,available_at timestamptz,claimed_at timestamptz,delivered_at timestamptz,last_error text,attempt_count int default 0,unique(target_id,event_type));
grant all on all tables in schema public to service_role;

\ir ../migrations/20261022140830_social_publish_recovery.sql
insert into social_posts(id,user_id,status,scheduled_at) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','publishing',now()-interval '1 hour');
insert into social_connections(id,user_id,provider,status,scopes) values
('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000010','instagram','active',array['instagram_business_content_publish']);
insert into social_post_targets(id,post_id,connection_id,provider,status,remote_post_id,last_error_code,upload_session_url,next_attempt_at) values
('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','instagram','failed','existing-container','processing_timeout',null,null),
('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','twitter','published','published-x',null,null,null),
('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','youtube','publishing',null,null,'https://www.googleapis.com/existing-upload',now()),
('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','linkedin','outcome_unknown',null,'outcome_unknown',null,now()),
('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','facebook','publishing',null,null,null,now());
DO $$ begin
  begin perform public.retry_failed_social_post_atomic('00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000001'); raise exception 'Cross-owner retry accepted'; exception when sqlstate '55000' then null; end;
  if exists(select 1 from social_post_targets where id='00000000-0000-4000-8000-000000000101' and status<>'failed') then raise exception 'Wrong-owner mutated target'; end if;
  if has_function_privilege('authenticated','public.retry_failed_social_post_atomic(uuid,uuid)','execute') or has_function_privilege('anon','public.claim_due_social_targets(integer,integer)','execute') or has_function_privilege('authenticated','public.recover_interrupted_social_targets()','execute') then raise exception 'Unexpected RPC privilege'; end if;
end $$;
select public.retry_failed_social_post_atomic('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001');
do $$ begin
 begin perform public.retry_failed_social_post_atomic('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001'); raise exception 'Duplicate retry accepted'; exception when sqlstate '55000' then null; end;
end $$;
DO $$ begin
 if (select count(*) from social_outbox_events)<>1 then raise exception 'Duplicate queued writes'; end if;
 if not exists(select 1 from social_post_targets where provider='instagram' and status='pending' and remote_post_id='existing-container' and processing_started_at is null) then raise exception 'Failed retry incorrect'; end if;
 if not exists(select 1 from social_post_targets where provider='twitter' and status='published' and remote_post_id='published-x') then raise exception 'Published destination changed'; end if;
 if not exists(select 1 from social_post_targets where provider='linkedin' and status='outcome_unknown') then raise exception 'Ambiguous destination changed'; end if;
end $$;
update social_post_targets set lease_expires_at=now()-interval '30 minutes',updated_at=now()-interval '30 minutes' where provider in ('youtube','facebook');
select public.recover_interrupted_social_targets();
select * from claim_due_social_targets(50,300);
DO $$ begin
 if not exists(select 1 from social_post_targets where provider='youtube' and status='queued' and upload_session_url='https://www.googleapis.com/existing-upload') then raise exception 'YouTube checkpoint did not resume'; end if;
 if not exists(select 1 from social_post_targets where provider='facebook' and status='outcome_unknown' and next_attempt_at is null) then raise exception 'Ambiguous interrupted write not held'; end if;
 if not exists(select 1 from social_post_targets where provider='linkedin' and status='outcome_unknown') then raise exception 'Unknown write unsafely queued'; end if;
end $$;

-- Expired sessions stay held. Transient ambiguous uploads may check the same session.
update social_post_targets set status='outcome_unknown',next_attempt_at=null,last_error_code='upload_session_expired',lease_expires_at=null where provider='youtube';
do $$ begin
  if exists(select 1 from public.claim_due_social_targets(50,300) where target_id='00000000-0000-4000-8000-000000000103') then raise exception 'Expired upload was reclaimed'; end if;
end $$;
update social_post_targets set next_attempt_at=now() where provider='youtube';
do $$ begin
  if exists(select 1 from public.claim_due_social_targets(50,300) where target_id='00000000-0000-4000-8000-000000000103') then raise exception 'Terminal expired code was reclaimed'; end if;
end $$;
update social_post_targets set last_error_code='outcome_unknown' where provider='youtube';
do $$ begin
  if not exists(select 1 from public.claim_due_social_targets(50,300) where target_id='00000000-0000-4000-8000-000000000103') then raise exception 'Resumable uncertain upload did not recover'; end if;
end $$;

-- An active lease or recent heartbeat must never be stolen by recovery.
update social_post_targets set status='publishing',lease_expires_at=now()+interval '5 minutes',updated_at=now() where provider='youtube';
select public.recover_interrupted_social_targets();
do $$ begin
 if not exists(select 1 from social_post_targets where provider='youtube' and status='publishing') then raise exception 'Recovery stole active upload'; end if;
end $$;
rollback;
