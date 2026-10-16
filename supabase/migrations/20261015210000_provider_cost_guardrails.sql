-- Shared, fail-closed limits. Units are documented per resource, never inferred from request count.
create table public.provider_budget_policies (
  resource text primary key,
  enabled boolean not null default true,
  daily_limit bigint not null check(daily_limit>=0),
  monthly_limit bigint not null check(monthly_limit>=0),
  workspace_daily_limit bigint not null check(workspace_daily_limit>=0),
  workspace_monthly_limit bigint not null check(workspace_monthly_limit>=0)
);
create table public.provider_budget_usage (
  resource text not null references public.provider_budget_policies(resource),
  scope text not null,
  period_kind text not null check(period_kind in ('day','month')),
  period_start date not null,
  units bigint not null default 0 check(units>=0),
  primary key(resource,scope,period_kind,period_start)
);
alter table public.provider_budget_policies enable row level security;
alter table public.provider_budget_usage enable row level security;
revoke all on public.provider_budget_policies,public.provider_budget_usage from public,anon,authenticated;
grant select,update on public.provider_budget_policies to service_role;
grant select on public.provider_budget_usage to service_role;

insert into public.provider_budget_policies values
  ('ai_microusd',true,10000000,100000000,1000000,5000000),
  ('public_ai_microusd',true,250000,5000000,250000,5000000),
  ('bright_data_requests',true,100,3000,20,100),
  ('x_read_units',false,100,1000,25,100),
  ('x_identity_reads',true,100,2000,3,10),
  ('apimart_images',true,100,1000,10,100),
  ('vision_images',true,100,2000,10,40),
  ('seo_images',true,2,35,2,35),
  ('transcription_requests',true,20,300,5,30),
  ('browser_milliseconds',true,3600000,108000000,120000,600000),
  ('marketing_emails',true,10000,100000,5000,25000),
  ('transactional_emails',true,5000,50000,1000,5000),
  ('image_transformations',true,10000,100000,100,1000),
  ('public_background_removals',true,50,500,50,500),
  ('analytics_events',true,10000,250000,1000,10000),
  ('x_write_actions',true,2500,30000,100,1000);

create function public.reserve_provider_usage(p_resource text,p_units bigint,p_workspace_id uuid default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare policy public.provider_budget_policies%rowtype;
  day_start date := (now() at time zone 'utc')::date;
  month_start date := date_trunc('month',now() at time zone 'utc')::date;
  owner_scope text := p_workspace_id::text;
  used_units bigint;
  item record;
begin
  if p_units is null or p_units<=0 then return false; end if;
  -- One short lock serializes reservations across all Worker instances. No network under lock.
  select * into policy from public.provider_budget_policies where resource=p_resource for update;
  if not found or not policy.enabled then return false; end if;
  for item in select * from (values
    ('global','day',day_start,policy.daily_limit),
    ('global','month',month_start,policy.monthly_limit),
    (owner_scope,'day',day_start,policy.workspace_daily_limit),
    (owner_scope,'month',month_start,policy.workspace_monthly_limit)
  ) as limits(scope,kind,start_date,cap) where scope is not null loop
    select units into used_units from public.provider_budget_usage
      where resource=p_resource and scope=item.scope and period_kind=item.kind and period_start=item.start_date;
    if p_units>item.cap-coalesce(used_units,0) then return false; end if;
  end loop;
  insert into public.provider_budget_usage(resource,scope,period_kind,period_start,units)
    select * from (values (p_resource,'global','day',day_start,p_units),
      (p_resource,'global','month',month_start,p_units),
      (p_resource,owner_scope,'day',day_start,p_units),
      (p_resource,owner_scope,'month',month_start,p_units)) as reservations(resource,scope,period_kind,period_start,units) where scope is not null
    on conflict(resource,scope,period_kind,period_start)
    do update set units=provider_budget_usage.units+excluded.units;
  return true;
end; $$;
revoke all on function public.reserve_provider_usage(text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.reserve_provider_usage(text,bigint,uuid) to service_role;

-- Stop automatic retries after three indexing failures. New source changes/manual requests can requeue.
create or replace function public.claim_creator_content_indexes(p_limit integer default 3)
returns setof public.creator_content_index_jobs language sql security definer set search_path=public as $$
  update creator_content_index_jobs jobs set status='running',lease_id=gen_random_uuid(),
    lease_expires_at=now()+interval '10 minutes',attempts=attempts+1
  where user_id in (
    select candidate.user_id from creator_content_index_jobs candidate
    where candidate.status in ('pending','running','error') and candidate.next_attempt_at<=now()
      and candidate.attempts<3
      and (candidate.lease_expires_at is null or candidate.lease_expires_at<=now())
      and not exists(select 1 from social_analytics_snapshots snapshots where snapshots.user_id=candidate.user_id
        and snapshots.refresh_job_id is not null and snapshots.refresh_started_at>now()-interval '15 minutes')
    order by candidate.next_attempt_at limit greatest(0,least(p_limit,5)) for update skip locked
  ) returning jobs.*;
$$;

-- Retain compact daily counters, discard only expired disposable caches/attempt telemetry in batches.
create function public.cleanup_provider_cost_data() returns void
language plpgsql security definer set search_path=public as $$
begin
  delete from public.provider_budget_usage where ctid in
    (select ctid from public.provider_budget_usage where period_start<current_date-100 limit 5000);
  delete from public.social_mention_search_cache where ctid in
    (select ctid from public.social_mention_search_cache where expires_at<now()-interval '7 days' limit 1000);
  delete from public.social_preview_attempts where ctid in
    (select ctid from public.social_preview_attempts where created_at<now()-interval '30 days' limit 5000);
end; $$;
revoke all on function public.cleanup_provider_cost_data() from public,anon,authenticated;
grant execute on function public.cleanup_provider_cost_data() to service_role;

-- Poll a tiny revision instead of transferring up to 100 complete messages every 30 seconds.
alter table public.content_agent_threads add column content_revision bigint not null default 0;
create function public.bump_content_thread_revision() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  update public.content_agent_threads set content_revision=content_revision+1
  where id=case when tg_op='DELETE' then old.thread_id else new.thread_id end;
  return null;
end; $$;
revoke all on function public.bump_content_thread_revision() from public,anon,authenticated;
create trigger content_messages_revision after insert or update or delete on public.content_agent_messages
  for each row execute function public.bump_content_thread_revision();
create index provider_budget_usage_retention_idx on public.provider_budget_usage(period_start);
create index social_mention_search_cache_expiry_idx on public.social_mention_search_cache(expires_at);
create index creator_content_media_active_lease_idx on public.creator_content_media(user_id,lease_expires_at)
  where lease_expires_at is not null;
