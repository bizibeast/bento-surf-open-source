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

create or replace function public.claim_due_seo_runs(
  p_environment text,
  p_limit integer default 10,
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
  if p_limit < 1 or p_limit > 50 then
    raise exception 'SEO run claim limit must be between 1 and 50';
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

  return query
  with candidates as (
    select id
      from public.seo_runs
     where environment = p_environment
       and kind <> 'control'
       and (
         (status in ('pending', 'retry') and coalesce(next_retry_at, p_now) <= p_now)
         or (status = 'running' and lease_expires_at <= p_now)
       )
     order by coalesce(next_retry_at, created_at), created_at
     for update skip locked
     limit p_limit
  )
  update public.seo_runs as run
     set status = 'running',
         lease_expires_at = p_now + interval '10 minutes',
         updated_at = p_now
    from candidates
   where run.id = candidates.id
  returning run.*;
end;
$$;
