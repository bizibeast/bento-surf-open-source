-- Private metadata only. Files use the existing quota-limited R2 bucket.
create table public.content_agent_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  storage_key text not null,
  name text not null check (length(name) between 1 and 160),
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  media_id uuid,
  etag text not null,
  status text not null default 'processing' check (status in ('processing','ready','failed')),
  extracted_text text not null default '' check (length(extracted_text) <= 20000),
  note text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now(),
  unique(user_id, storage_key)
);
create index content_agent_attachments_user_created on public.content_agent_attachments(user_id, created_at desc);
alter table public.content_agent_attachments enable row level security;
revoke all on public.content_agent_attachments from anon, authenticated;
grant all on public.content_agent_attachments to service_role;

create table public.content_agent_app_actions (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.content_agent_messages(id) on delete cascade,
  tool_name text not null,
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object' and octet_length(arguments::text) <= 65536),
  status text not null default 'pending' check (status in ('pending','running','completed','failed','dismissed')),
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index content_agent_app_actions_message on public.content_agent_app_actions(user_id, message_id);
alter table public.content_agent_app_actions enable row level security;
revoke all on public.content_agent_app_actions from anon, authenticated;
grant all on public.content_agent_app_actions to service_role;

-- Serialize preparation per workspace, including parallel requests for the same file.
-- Failed attempts consume the monthly allowance too; metadata expires with chat history.
create function public.claim_content_agent_attachment(p_user_id uuid, p_key text, p_name text,
  p_mime text, p_bytes bigint, p_etag text) returns jsonb language plpgsql security definer
  set search_path = public as $$
declare existing public.content_agent_attachments; total integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('agent-attachment:' || p_user_id::text, 0));
  delete from public.content_agent_attachments where user_id = p_user_id and created_at < now() - interval '30 days';
  select * into existing from public.content_agent_attachments where user_id = p_user_id and storage_key = p_key;
  if found then return jsonb_build_object('claimed', false, 'attachment', to_jsonb(existing)); end if;
  select count(*) into total from public.content_agent_attachments where user_id = p_user_id;
  if total >= 100 then raise exception 'Agent supports up to 100 new file references per 30 days. Reuse a recent file or try again when the allowance resets.'; end if;
  if p_key not like 'users/' || p_user_id::text || '/%' and p_key not like 'private/users/' || p_user_id::text || '/agent/%' then
    raise exception 'Attachment belongs to another workspace';
  end if;
  insert into public.content_agent_attachments(user_id,storage_key,name,mime_type,byte_size,etag)
    values(p_user_id,p_key,p_name,p_mime,p_bytes,p_etag) returning * into existing;
  return jsonb_build_object('claimed', true, 'attachment', to_jsonb(existing));
end $$;
revoke all on function public.claim_content_agent_attachment(uuid,text,text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.claim_content_agent_attachment(uuid,text,text,text,bigint,text) to service_role;
