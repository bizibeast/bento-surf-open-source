-- Retries across Worker instances share one short, owner-scoped refresh lease.
-- No transaction stays open during search/provider calls.
create table public.discover_refresh_leases (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  lease_key uuid not null,
  lease_until timestamptz not null
);

alter table public.discover_refresh_leases enable row level security;
revoke all on public.discover_refresh_leases from public, anon, authenticated;
grant all on public.discover_refresh_leases to service_role;

-- Platform quotas now retain up to 96 public posts in a shared niche brief.
alter table public.content_trend_briefs
  drop constraint content_trend_briefs_items_check;
alter table public.content_trend_briefs
  add constraint content_trend_briefs_items_check
  check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 96);

create function public.claim_discover_refresh(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  token uuid := gen_random_uuid();
  claimed uuid;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return null;
  end if;

  insert into public.discover_refresh_leases (user_id, lease_key, lease_until)
    values (p_user_id, token, clock_timestamp() + interval '120 seconds')
    on conflict (user_id) do update
      set lease_key = excluded.lease_key, lease_until = excluded.lease_until
      where discover_refresh_leases.lease_until <= clock_timestamp()
    returning lease_key into claimed;
  return claimed;
end;
$$;

create function public.is_discover_refresh_current(p_user_id uuid, p_lease_key uuid)
returns boolean language sql security definer set search_path = '' as $$
  select exists (
    select 1 from public.discover_refresh_leases
    where user_id = p_user_id and lease_key = p_lease_key
      and lease_until > clock_timestamp()
  );
$$;

create function public.release_discover_refresh(p_user_id uuid, p_lease_key uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.discover_refresh_leases
    where user_id = p_user_id and lease_key = p_lease_key;
$$;

-- Fence the write in the same transaction as the lease check. Holding this short
-- row lock also prevents an expired claim from being replaced midway through a
-- commit; provider/network work has already completed before this RPC starts.
create function public.save_discover_recommendations(
  p_user_id uuid,
  p_lease_key uuid,
  p_rows jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  current_key uuid;
  current_until timestamptz;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Discover recommendations must be an array.';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'Too many Discover recommendations.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as entries(item)
    where jsonb_typeof(item) is distinct from 'object'
      or (item->>'user_id')::uuid is distinct from p_user_id
  ) then
    raise exception 'Discover recommendation owner mismatch.';
  end if;

  select lease_key, lease_until into current_key, current_until
    from public.discover_refresh_leases
    where user_id = p_user_id
    for update;
  if not found or current_key is distinct from p_lease_key
    or current_until <= clock_timestamp() then
    return false;
  end if;

  insert into public.creator_content_recommendations as existing (
    user_id, fingerprint, kind, title, summary, source_url, source_name,
    source_published_at, source_retrieved_at, reason, angles, metric_name,
    metric_value, outlier_score, metadata, content_insight_id, trend_brief_id, feedback
  )
  select
    p_user_id, row.fingerprint, row.kind, row.title, coalesce(row.summary, ''),
    row.source_url, row.source_name, row.source_published_at, row.source_retrieved_at,
    coalesce(row.reason, ''), coalesce(row.angles, '[]'::jsonb), row.metric_name,
    row.metric_value, row.outlier_score, coalesce(row.metadata, '{}'::jsonb),
    row.content_insight_id, row.trend_brief_id, 'pending'
  from jsonb_populate_recordset(null::public.creator_content_recommendations, p_rows) as row
  on conflict (user_id, fingerprint) do update set
    kind = excluded.kind,
    title = excluded.title,
    summary = excluded.summary,
    source_url = excluded.source_url,
    source_name = excluded.source_name,
    source_published_at = excluded.source_published_at,
    source_retrieved_at = excluded.source_retrieved_at,
    reason = excluded.reason,
    angles = excluded.angles,
    metric_name = excluded.metric_name,
    metric_value = excluded.metric_value,
    outlier_score = excluded.outlier_score,
    metadata = excluded.metadata || jsonb_build_object(
      'saved', existing.feedback = 'saved' or coalesce(existing.metadata->'saved', 'false'::jsonb) = 'true'::jsonb
    ),
    content_insight_id = excluded.content_insight_id,
    trend_brief_id = excluded.trend_brief_id,
    feedback = existing.feedback,
    updated_at = now();
  return true;
end;
$$;

revoke all on function public.claim_discover_refresh(uuid),
  public.is_discover_refresh_current(uuid, uuid),
  public.release_discover_refresh(uuid, uuid),
  public.save_discover_recommendations(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_discover_refresh(uuid),
  public.is_discover_refresh_current(uuid, uuid),
  public.release_discover_refresh(uuid, uuid),
  public.save_discover_recommendations(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
