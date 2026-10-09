-- A native repost is a separate, durable action on an already published target.
-- Removal is timed from the original publication, not from queue execution.
create table public.social_repost_jobs (
  target_id uuid primary key references public.social_post_targets(id) on delete cascade,
  provider text not null check (provider in ('linkedin', 'twitter')),
  after_hours integer not null check (after_hours between 1 and 168),
  remove_after_hours integer check (remove_after_hours between 2 and 336 and remove_after_hours > after_hours),
  repost_due_at timestamptz not null,
  remove_due_at timestamptz,
  phase text not null default 'pending' check (
    phase in ('pending', 'repost_queued', 'reposting', 'repost_retry', 'reposted',
              'remove_queued', 'removing', 'remove_retry', 'removed', 'complete',
              'failed', 'outcome_unknown')
  ),
  repost_remote_id text,
  reposted_at timestamptz,
  removed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz,
  lease_expires_at timestamptz,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_repost_remove_time_check check (
    (remove_after_hours is null and remove_due_at is null) or
    (remove_after_hours is not null and remove_due_at > repost_due_at)
  )
);

create index social_repost_jobs_due_idx
  on public.social_repost_jobs(phase, next_attempt_at, repost_due_at, remove_due_at)
  where phase in ('pending', 'repost_queued', 'repost_retry', 'reposted', 'remove_queued', 'remove_retry');

alter table public.social_repost_jobs enable row level security;
revoke all on public.social_repost_jobs from public, anon, authenticated;
grant all on public.social_repost_jobs to service_role;

create trigger social_repost_jobs_updated_at
  before update on public.social_repost_jobs
  for each row execute function public.tg_set_updated_at();

create or replace function public.create_social_repost_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_options jsonb;
  v_after integer;
  v_remove integer;
begin
  if new.status <> 'published' or new.published_at is null or new.remote_post_id is null
     or new.provider not in ('linkedin', 'twitter') then
    return new;
  end if;
  v_options := new.provider_settings -> 'autoRepost';
  if v_options is null or jsonb_typeof(v_options) <> 'object' then
    return new;
  end if;
  if coalesce(v_options ->> 'afterHours', '') !~ '^[0-9]{1,3}$' then
    return new;
  end if;
  v_after := (v_options ->> 'afterHours')::integer;
  if v_after not between 1 and 168 then
    return new;
  end if;
  if v_options ->> 'removeAfterHours' is not null then
    if (v_options ->> 'removeAfterHours') !~ '^[0-9]{1,3}$' then
      return new;
    end if;
    v_remove := (v_options ->> 'removeAfterHours')::integer;
    if v_remove <= v_after or v_remove > 336 then
      return new;
    end if;
  end if;
  insert into public.social_repost_jobs (
    target_id, provider, after_hours, remove_after_hours, repost_due_at, remove_due_at
  ) values (
    new.id, new.provider, v_after, v_remove,
    new.published_at + make_interval(hours => v_after),
    case when v_remove is null then null else new.published_at + make_interval(hours => v_remove) end
  ) on conflict (target_id) do nothing;
  return new;
end;
$$;

create trigger social_target_published_repost
  after update of status, published_at on public.social_post_targets
  for each row when (new.status = 'published')
  execute function public.create_social_repost_job();

create or replace function public.claim_due_social_repost_jobs(
  claim_limit integer default 50,
  lease_seconds integer default 300
)
returns table(job_target_id uuid, job_provider text, job_phase text)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Retrying a LinkedIn reshare after a worker disappears could create a duplicate.
  -- X reposts and both removal endpoints can be retried safely.
  update public.social_repost_jobs
  set phase = case
        when phase = 'reposting' and provider = 'linkedin' then 'outcome_unknown'
        when phase = 'reposting' then 'repost_retry'
        else 'remove_retry'
      end,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_message = case when phase = 'reposting' and provider = 'linkedin'
        then 'LinkedIn may have created the repost. Check LinkedIn before retrying.'
        else 'The repost worker stopped before confirming the action.' end
  where phase in ('reposting', 'removing')
    and lease_expires_at < now();

  return query
  with due as (
    select job.target_id,
      case when job.phase in ('reposted', 'remove_queued', 'remove_retry')
        then 'remove_queued' else 'repost_queued' end as next_phase
    from public.social_repost_jobs job
    join public.social_post_targets target on target.id = job.target_id
    where target.status = 'published'
      and (
        (job.phase in ('pending', 'repost_retry', 'repost_queued')
          and coalesce(job.next_attempt_at, job.repost_due_at) <= now())
        or
        (job.phase in ('reposted', 'remove_retry', 'remove_queued')
          and job.remove_due_at is not null
          and coalesce(job.next_attempt_at, job.remove_due_at) <= now())
      )
      and (job.lease_expires_at is null or job.lease_expires_at <= now())
    order by coalesce(job.next_attempt_at, job.remove_due_at, job.repost_due_at)
    for update of job skip locked
    limit greatest(1, least(claim_limit, 100))
  )
  update public.social_repost_jobs job
  set phase = due.next_phase,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(lease_seconds, 900)))
  from due
  where job.target_id = due.target_id
  returning job.target_id, job.provider, job.phase;
end;
$$;

revoke all on function public.claim_due_social_repost_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_social_repost_jobs(integer, integer)
  to service_role;
