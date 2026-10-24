-- Receipts are evidence about exact generated content, not a new creator permission.
-- Legacy rows remain intact; application reads expose unverified generated rows for review.
alter table public.creator_brain_items
  add column if not exists evidence_verification jsonb;

create or replace function public.brain_item_evidence_hash(
  p_kind text, p_title text, p_content text, p_source_ref text, p_source_url text
) returns text language sql immutable set search_path='' as $$
  select encode(pg_catalog.sha256(convert_to(string_agg(octet_length(value)::text || ':' || value, '|' order by ordinal), 'UTF8')), 'hex')
  from unnest(array['3', coalesce(p_kind,''), coalesce(p_title,''), coalesce(p_content,''),
    coalesce(p_source_ref,''), coalesce(p_source_url,'')]) with ordinality as fields(value,ordinal);
$$;
revoke all on function public.brain_item_evidence_hash(text,text,text,text,text) from public,anon;
grant execute on function public.brain_item_evidence_hash(text,text,text,text,text) to authenticated,service_role;

create or replace function public.guard_brain_evidence_receipt()
returns trigger language plpgsql set search_path='' as $$
declare receipt jsonb;
begin
  -- SECURITY INVOKER intentionally retains the caller role. Browser writes cannot
  -- create/replace receipts, including when the document hash is guessed correctly.
  if current_user not in ('postgres','service_role','supabase_admin') and
    not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper) then
    if tg_op='UPDATE' then new.evidence_verification:=old.evidence_verification;
    else new.evidence_verification:=null; end if;
  end if;
  receipt:=new.evidence_verification;
  if receipt is null then return new; end if;
  if jsonb_typeof(receipt) is distinct from 'object' or
    jsonb_typeof(receipt->'sources') is distinct from 'array' then
    new.evidence_verification:=null; return new;
  end if;
  if receipt->'version' is distinct from '3'::jsonb or
    receipt->>'state' is distinct from 'verified' or
    coalesce(receipt->>'method','') not in ('independent_source_review','operator_source_audit') or
    jsonb_typeof(receipt->'reviewedAt') is distinct from 'string' or
    jsonb_array_length(receipt->'sources') not between 1 and 32 or
    receipt->>'documentHash' is distinct from public.brain_item_evidence_hash(
      new.kind,new.title,new.content,new.source_ref,new.source_url
    ) or exists(select 1 from jsonb_array_elements(receipt->'sources') source where
      jsonb_typeof(source) is distinct from 'object' or
      coalesce(source->>'id','')='' or
      coalesce(source->>'sha256','') !~ '^[a-f0-9]{64}$'
    ) then new.evidence_verification:=null;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_brain_evidence_receipt() from public,anon,authenticated;
create trigger creator_brain_evidence_guard before insert or update
  on public.creator_brain_items for each row execute function public.guard_brain_evidence_receipt();

comment on column public.creator_brain_items.evidence_verification is
  'Server/operator source-review receipt for exact generated Brain content; invalidated by edits. Creator confirmations remain explicit and separate.';

-- Explicit operator repairs retain history. Ordinary reads/indexing do not append
-- unlimited audit records. Workspace deletion still removes its private audit data.
create table if not exists public.creator_brain_evidence_audits (
  id uuid primary key default gen_random_uuid(),
  audit_id text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  brain_item_id uuid not null,
  before_record jsonb not null,
  after_record jsonb not null,
  source_snapshots jsonb not null,
  created_at timestamptz not null default now(),
  unique(audit_id,brain_item_id)
);
alter table public.creator_brain_evidence_audits enable row level security;
revoke all on public.creator_brain_evidence_audits from public,anon,authenticated,service_role;
grant select,insert on public.creator_brain_evidence_audits to service_role;
create index if not exists creator_brain_evidence_audits_workspace_idx
  on public.creator_brain_evidence_audits(user_id,created_at);
