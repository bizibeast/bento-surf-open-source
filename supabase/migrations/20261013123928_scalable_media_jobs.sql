-- One shared project budget, locked while imports are claimed.
create table public.creator_media_import_budget (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  daily_limit integer not null default 100 check (daily_limit between 0 and 100000),
  monthly_limit integer not null default 2000 check (monthly_limit between 0 and 1000000),
  day_start date not null default (now() at time zone 'utc')::date,
  day_used integer not null default 0 check (day_used>=0),
  month_start date not null default date_trunc('month',now() at time zone 'utc')::date,
  month_used integer not null default 0 check (month_used>=0)
);
insert into public.creator_media_import_budget (id) values (true);
alter table public.creator_media_import_budget enable row level security;
revoke all on public.creator_media_import_budget from public,anon,authenticated;
grant select,update on public.creator_media_import_budget to service_role;

create or replace function public.claim_creator_media_imports(p_limit integer default 100)
returns table(id uuid,user_id uuid,lease_id uuid)
language plpgsql security definer set search_path=public as $$
declare budget public.creator_media_import_budget%rowtype;
  today date:=(now() at time zone 'utc')::date;
  month_begin date:=date_trunc('month',now() at time zone 'utc')::date;
  allowance integer; claimed integer;
begin
  select * into budget from public.creator_media_import_budget where creator_media_import_budget.id=true for update;
  if not found or budget.paused then return; end if;
  if budget.day_start<>today then budget.day_start:=today; budget.day_used:=0; end if;
  if budget.month_start<>month_begin then budget.month_start:=month_begin; budget.month_used:=0; end if;
  allowance:=least(greatest(0,least(p_limit,100)),budget.daily_limit-budget.day_used,
    budget.monthly_limit-budget.month_used);
  if allowance<=0 then
    update public.creator_media_import_budget set day_start=budget.day_start,day_used=budget.day_used,
      month_start=budget.month_start,month_used=budget.month_used where creator_media_import_budget.id=true;
    return;
  end if;
  return query with first_due as (
    select distinct on (candidate.user_id) candidate.id,candidate.user_id,
      candidate.next_attempt_at,candidate.import_origin
    from public.creator_content_media candidate
    where candidate.status='pending' and candidate.import_origin in ('automatic','requested')
      and candidate.next_attempt_at<=now()
      and (candidate.lease_expires_at is null or candidate.lease_expires_at<=now())
      and not exists (select 1 from public.creator_content_media active
        where active.user_id=candidate.user_id and active.lease_expires_at>now())
    order by candidate.user_id,case when candidate.import_origin='requested' then 0 else 1 end,
      candidate.next_attempt_at,candidate.created_at
  ), chosen as (
    select media.id from public.creator_content_media media
    join first_due on first_due.id=media.id
    order by case when first_due.import_origin='requested' then 0 else 1 end,
      first_due.next_attempt_at
    limit allowance for update of media skip locked
  )
  update public.creator_content_media media set lease_id=gen_random_uuid(),
    lease_expires_at=now()+interval '10 minutes'
  where media.id in (select chosen.id from chosen)
  returning media.id,media.user_id,media.lease_id;
  get diagnostics claimed=row_count;
  update public.creator_media_import_budget set day_start=budget.day_start,
    day_used=budget.day_used+claimed,month_start=budget.month_start,
    month_used=budget.month_used+claimed where creator_media_import_budget.id=true;
end; $$;
revoke all on function public.claim_creator_media_imports(integer) from public,anon,authenticated;
grant execute on function public.claim_creator_media_imports(integer) to service_role;

-- Re-rank when Social Insights changes, without re-running Brain AI.
create table public.creator_media_rank_refresh (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  due_at timestamptz not null default now()
);
alter table public.creator_media_rank_refresh enable row level security;
revoke all on public.creator_media_rank_refresh from public,anon,authenticated;
grant all on public.creator_media_rank_refresh to service_role;
create function public.queue_creator_media_rank_refresh() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_op='UPDATE' then
    if old.engagements is not distinct from new.engagements
      and old.media_sources is not distinct from new.media_sources
      and old.published_at is not distinct from new.published_at then return new; end if;
  end if;
  insert into public.creator_media_rank_refresh(user_id,due_at)
    values(new.user_id,now()+interval '2 minutes')
  on conflict(user_id) do nothing;
  return new;
end; $$;
revoke all on function public.queue_creator_media_rank_refresh() from public,anon,authenticated;
create trigger social_content_media_rank_refresh
  after insert or update of engagements,media_sources,published_at on public.social_content_insights
  for each row execute function public.queue_creator_media_rank_refresh();
create function public.process_due_creator_media_rank_refreshes(p_limit integer default 3)
returns integer language plpgsql security definer set search_path=public as $$
declare job record; processed integer:=0;
begin
  for job in select user_id from public.creator_media_rank_refresh
    where due_at<=now() order by due_at limit greatest(0,least(p_limit,10)) for update skip locked loop
    perform public.refresh_creator_auto_media(job.user_id);
    delete from public.creator_media_rank_refresh where creator_media_rank_refresh.user_id=job.user_id;
    processed:=processed+1;
  end loop;
  return processed;
end; $$;
revoke all on function public.process_due_creator_media_rank_refreshes(integer) from public,anon,authenticated;
grant execute on function public.process_due_creator_media_rank_refreshes(integer) to service_role;

-- Short-lived R2 inventory cache, adjusted after imports and reconciled after 15 minutes.
create table public.creator_r2_usage_cache (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  used_bytes bigint not null check (used_bytes>=0),
  reconciled_at timestamptz not null default now()
);
alter table public.creator_r2_usage_cache enable row level security;
revoke all on public.creator_r2_usage_cache from public,anon,authenticated;
grant all on public.creator_r2_usage_cache to service_role;
create function public.adjust_creator_r2_usage(p_user_id uuid,p_delta bigint)
returns void language sql security definer set search_path=public as $$
  update public.creator_r2_usage_cache set used_bytes=greatest(0,used_bytes+p_delta)
  where user_id=p_user_id;
$$;
revoke all on function public.adjust_creator_r2_usage(uuid,bigint) from public,anon,authenticated;
grant execute on function public.adjust_creator_r2_usage(uuid,bigint) to service_role;

-- Preview only: never delete old files during migration.
create function public.creator_legacy_media_cleanup_preview(p_user_id uuid)
returns table(item_count bigint,possible_bytes bigint,items jsonb)
language sql stable security definer set search_path=public as $$
  with candidates as (
    select distinct on (media.storage_key) media.id,media.caption,media.provider,
      media.storage_key,media.byte_size as bytes
    from public.creator_content_media media
    where media.user_id=p_user_id and media.status='ready'
      and media.import_origin in ('legacy','catalog') and media.hero_slot is null
      and media.storage_key like 'users/'||p_user_id::text||'/content-media/%'
      and not exists (select 1 from public.creator_content_media other_media
        where other_media.user_id=p_user_id and other_media.storage_key=media.storage_key
          and (other_media.import_origin in ('automatic','requested','upload') or other_media.hero_slot is not null))
    order by media.storage_key,media.byte_size desc
  ) select count(*)::bigint,coalesce(sum(bytes),0)::bigint,
    coalesce((select jsonb_agg(to_jsonb(sample)) from (
      select id,left(caption,100) as title,provider,bytes as byte_size
      from candidates order by bytes desc limit 10
    ) sample),'[]'::jsonb) from candidates;
$$;
revoke all on function public.creator_legacy_media_cleanup_preview(uuid) from public,anon,authenticated;
grant execute on function public.creator_legacy_media_cleanup_preview(uuid) to service_role;
