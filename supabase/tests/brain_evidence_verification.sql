-- Empty disposable PostgreSQL only. Entire fixture and role changes roll back.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.profiles(id uuid primary key);
create table public.creator_brain_items(
  id uuid primary key,user_id uuid references public.profiles(id),kind text,title text,content text,
  source_ref text,source_url text,status text,locked boolean,provenance text
);
grant select,insert,update on public.creator_brain_items to authenticated,service_role;
grant select on public.profiles to authenticated,service_role;
insert into public.profiles values('00000000-0000-4000-8000-000000000001');
\ir ../migrations/20261023020730_brain_evidence_verification.sql

create function public.fixture_brain_receipt(k text,t text,c text,r text,u text)
returns jsonb language sql as $$ select jsonb_build_object(
  'version',3,'state','verified','documentHash',public.brain_item_evidence_hash(k,t,c,r,u),
  'reviewedAt','2026-10-23T00:00:00Z','method','operator_source_audit','auditId','trusted-operator',
  'sources',jsonb_build_array(jsonb_build_object('id','source:1','sha256',repeat('a',64),'asOf',null))
); $$;

set local role authenticated;
insert into public.creator_brain_items values(
 '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',
 'story','Tool 👩🏽‍💻','I discussed a tool.','instagram:1','https://example.com/1','confirmed',false,'social_post',
 public.fixture_brain_receipt('story','Tool 👩🏽‍💻','I discussed a tool.','instagram:1','https://example.com/1')
);
do $$ begin
 if exists(select 1 from public.creator_brain_items where evidence_verification is not null) then raise exception 'Authenticated caller forged receipt'; end if;
end $$;

set local role service_role;
update public.creator_brain_items set evidence_verification=public.fixture_brain_receipt(kind,title,content,source_ref,source_url);
do $$ begin
 if not exists(select 1 from public.creator_brain_items where evidence_verification->>'auditId'='trusted-operator') then raise exception 'Service receipt rejected'; end if;
end $$;

set local role authenticated;
update public.creator_brain_items set evidence_verification=jsonb_set(evidence_verification,'{auditId}','"forged"');
do $$ begin
 if exists(select 1 from public.creator_brain_items where evidence_verification->>'auditId'<>'trusted-operator') then raise exception 'Authenticated caller replaced receipt'; end if;
end $$;
update public.creator_brain_items set content='I built the tool.',
 evidence_verification=public.fixture_brain_receipt(kind,title,'I built the tool.',source_ref,source_url);
do $$ begin
 if exists(select 1 from public.creator_brain_items where evidence_verification is not null) then raise exception 'Changed content retained or forged receipt'; end if;
end $$;

set local role service_role;
update public.creator_brain_items set evidence_verification=public.fixture_brain_receipt(kind,title,content,source_ref,source_url);
update public.creator_brain_items set source_url='https://example.com/different';
do $$ begin
 if exists(select 1 from public.creator_brain_items where evidence_verification is not null) then raise exception 'Source edit retained receipt'; end if;
end $$;
update public.creator_brain_items set evidence_verification=jsonb_set(public.fixture_brain_receipt(kind,title,content,source_ref,source_url),'{version}','2');
do $$ begin
 if exists(select 1 from public.creator_brain_items where evidence_verification is not null) then raise exception 'Old version trusted'; end if;
end $$;
update public.creator_brain_items set evidence_verification=jsonb_set(public.fixture_brain_receipt(kind,title,content,source_ref,source_url),'{sources}','[]');
do $$ begin
 if exists(select 1 from public.creator_brain_items where evidence_verification is not null) then raise exception 'Empty evidence trusted'; end if;
end $$;

reset role;
do $$ begin
 if has_table_privilege('authenticated','public.creator_brain_evidence_audits','select') or
    has_table_privilege('anon','public.creator_brain_evidence_audits','select') or
    has_table_privilege('service_role','public.creator_brain_evidence_audits','delete') then
   raise exception 'Audit history grants are too broad';
 end if;
 if not (select relrowsecurity from pg_class where oid='public.creator_brain_evidence_audits'::regclass) then raise exception 'Audit RLS missing'; end if;
 raise notice 'PASS: caller forgery, stale content/source, version/source shape, and private immutable audit grants';
end $$;
do $$ begin
 if public.brain_item_evidence_hash('story','Unicode 👩🏽‍💻|₹',E'Quoted "text"\nwith|boundaries','instagram:1',null) <> '496ffded7024ba541bdbabe85d73d6139d43c8d0d67612be4fe7e61c2d303bee' then
  raise exception 'SQL/JS UTF-8 hash parity failed';
 end if;
 raise notice 'PASS: SQL/JS Unicode, newline and field-boundary hash parity';
end $$;
rollback;
