-- Cloud briefs and the autopublish cron both used publication slot 10:00.
-- The slot unique index made claim_seo_publication_run either collide with the
-- cloud row or, once that insert was swallowed, claim the cloud run itself.
-- Keep the families apart: cloud keys own the slot index, and the cron neither
-- inserts nor claims a date that already has a cloud publication row.

drop index if exists public.seo_runs_publication_slot_unique;
create unique index seo_runs_publication_slot_unique
  on public.seo_runs (environment, publication_date, publication_slot)
  where kind = 'publication' and idempotency_key like 'cloud:%';

create or replace function public.claim_seo_publication_run(
  p_environment text,
  p_publication_date date,
  p_now timestamptz default now()
)
returns setof public.seo_runs
language plpgsql
security invoker
set search_path = public
as $$
declare
  control_action text;
begin
  if p_environment not in ('local', 'staging', 'production') then
    raise exception 'invalid SEO environment';
  end if;

  select checkpoints ->> 'action'
    into control_action
    from public.seo_runs
   where environment = p_environment
     and kind = 'control'
    and idempotency_key like ('control:' || p_environment || ':%')
   order by created_at desc, id desc
   limit 1;

  if control_action = 'pause'
    or (control_action is null and p_environment = 'production') then
    return;
  end if;

  if exists (
    select 1
      from public.seo_runs
     where environment = p_environment
       and kind = 'publication'
       and publication_date = p_publication_date
       and idempotency_key like 'cloud:%'
  ) then
    return;
  end if;

  insert into public.seo_runs (
    idempotency_key,
    environment,
    kind,
    publication_date,
    stage,
    status,
    next_retry_at
  ) values (
    'publication:' || p_environment || ':' || p_publication_date::text,
    p_environment,
    'publication',
    p_publication_date,
    'research',
    'pending',
    p_now
  )
  on conflict do nothing;

  return query
  with candidate as (
    select id
      from public.seo_runs
     where environment = p_environment
       and kind = 'publication'
       and publication_date = p_publication_date
       and idempotency_key not like 'cloud:%'
       and (
         (status in ('pending', 'retry') and coalesce(next_retry_at, p_now) <= p_now)
         or (status = 'running' and lease_expires_at <= p_now)
       )
     for update skip locked
     limit 1
  )
  update public.seo_runs as run
     set status = 'running',
         lease_expires_at = p_now + interval '10 minutes',
         updated_at = p_now
    from candidate
   where run.id = candidate.id
  returning run.*;
end;
$$;
