-- One owned Instagram image for an active onboarding preparation. Reuses the
-- same global import budget, per-workspace lease, and importer storage checks.
create function public.claim_onboarding_instagram_photo(p_user_id uuid, p_post_id uuid)
returns table(id uuid, user_id uuid, lease_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  budget public.creator_media_import_budget%rowtype;
  source public.social_content_insights%rowtype;
  media public.creator_content_media%rowtype;
  selected_asset_id text;
  media_id uuid;
  next_lease uuid;
  today date := (now() at time zone 'utc')::date;
  month_begin date := date_trunc('month', now() at time zone 'utc')::date;
begin
  if not exists (select 1 from public.onboarding_sessions s
    where s.workspace_id=p_user_id and s.status<>'applied' and s.job_status='running'
      and s.job_lease_until>now() and s.generation_count between 1 and 2) then
    raise exception 'An active onboarding preparation is required';
  end if;
  select * into budget from public.creator_media_import_budget b where b.id=true for update;
  if not found then return; end if;
  select p.* into source from public.social_content_insights p
    join public.social_connections c on c.id=p.connection_id and c.user_id=p.user_id
    where p.id=p_post_id and p.user_id=p_user_id and p.provider='instagram' and c.provider='instagram' and c.status='active';
  if not found then raise exception 'Choose an image from this workspace''s connected Instagram'; end if;
  select value->>'id' into selected_asset_id from jsonb_array_elements(source.media_sources) with ordinality asset(value,ord)
    where value->>'type'='image' and nullif(value->>'id','') is not null
      and nullif(value->>'url','') is not null order by ord limit 1;
  if selected_asset_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select m.* into media from public.creator_content_media m
    where m.user_id=p_user_id and m.connection_id=source.connection_id
      and m.post_id=source.remote_post_id and m.asset_id=selected_asset_id for update;
  if found and media.status='ready' then
    return query select media.id,p_user_id,null::uuid;
    return;
  end if;
  if media.lease_expires_at>now() or exists (select 1 from public.creator_content_media m
    where m.user_id=p_user_id and m.lease_expires_at>now()) then return; end if;
  if budget.day_start<>today then budget.day_start:=today; budget.day_used:=0; end if;
  if budget.month_start<>month_begin then budget.month_start:=month_begin; budget.month_used:=0; end if;
  if budget.paused or budget.day_used>=budget.daily_limit or budget.month_used>=budget.monthly_limit then return; end if;
  media_id := public.request_creator_media_from_post(p_user_id,p_post_id);
  next_lease := gen_random_uuid();
  update public.creator_content_media m set lease_id=next_lease,lease_expires_at=now()+interval '10 minutes'
    where m.id=media_id and m.user_id=p_user_id and m.status='pending';
  if not found then return; end if;
  update public.creator_media_import_budget b set day_start=budget.day_start,day_used=budget.day_used+1,
    month_start=budget.month_start,month_used=budget.month_used+1 where b.id=true;
  return query select media_id,p_user_id,next_lease;
end; $$;
revoke all on function public.claim_onboarding_instagram_photo(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_onboarding_instagram_photo(uuid,uuid) to service_role;

create function public.attach_onboarding_instagram_photo(p_workspace_id uuid, p_revision integer)
returns table(message_id uuid, card_id text)
language plpgsql security definer set search_path = '' as $$
declare
  setup public.onboarding_sessions%rowtype;
  message public.content_agent_messages%rowtype;
  draft record;
  card_name text;
  card_index integer;
  card jsonb;
  ids jsonb;
begin
  select * into setup from public.onboarding_sessions s where s.workspace_id=p_workspace_id for update;
  if not found or setup.status<>'applied' or setup.applied_revision is distinct from p_revision or setup.revision is distinct from p_revision then return; end if;
  select * into message from public.content_agent_messages m
    where m.user_id=p_workspace_id and m.thread_id=setup.thread_id and m.role='assistant'
    order by m.created_at limit 1 for update;
  if not found or jsonb_typeof(message.payload->'cards') is distinct from 'array' then return; end if;
  for draft in select value,ord from jsonb_array_elements(setup.candidates->'drafts') with ordinality d(value,ord) loop
    ids := draft.value->'mediaIds';
    if draft.value->>'platform' is distinct from 'linkedin' or jsonb_typeof(ids) is distinct from 'array' then continue; end if;
    if jsonb_array_length(ids)<>1 then continue; end if;
    if exists (select 1 from jsonb_array_elements_text(ids) photo(id) where not exists (
      select 1 from public.creator_content_media m where m.id::text=photo.id and m.user_id=p_workspace_id
        and m.provider='instagram' and m.media_type='image' and m.status='ready'
        and m.mime_type in ('image/jpeg','image/png','image/webp'))) then continue; end if;
    card_name := 'onboarding-' || draft.ord;
    select (c.ord-1)::integer,c.value into card_index,card
      from jsonb_array_elements(message.payload->'cards') with ordinality c(value,ord)
      where c.value->>'cardId'=card_name and c.value->>'type'='draft';
    if card_index is null or card->>'body' is distinct from draft.value->>'body' then continue; end if;
    -- Never overwrite an edited/prepared card or a different deliberate attachment.
    if message.payload->'draftStates'->card_name is not null then continue; end if;
    if coalesce(card->'mediaIds','[]'::jsonb) not in ('[]'::jsonb,ids) then continue; end if;
    message.payload := jsonb_set(message.payload,array['cards',card_index::text,'mediaIds'],ids,true);
    update public.content_agent_messages m set payload=message.payload where m.id=message.id and m.user_id=p_workspace_id;
    return query select message.id,card_name;
  end loop;
end; $$;
revoke all on function public.attach_onboarding_instagram_photo(uuid,integer) from public,anon,authenticated;
grant execute on function public.attach_onboarding_instagram_photo(uuid,integer) to service_role;

notify pgrst, 'reload schema';
