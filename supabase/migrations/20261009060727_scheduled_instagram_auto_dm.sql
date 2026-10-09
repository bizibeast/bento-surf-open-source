-- A published scheduler post may own one Instagram automation per account.
-- The automation is created only after Instagram confirms the media is live.
alter table public.instagram_dm_automations
  add column if not exists scheduled_post_id uuid references public.social_posts(id) on delete set null;

create unique index if not exists instagram_dm_automations_scheduled_post_connection_idx
  on public.instagram_dm_automations(scheduled_post_id, connection_id)
  where scheduled_post_id is not null;

create index if not exists social_post_targets_scheduled_auto_dm_idx
  on public.social_post_targets(published_at)
  where provider = 'instagram' and status = 'published'
    and provider_settings ? 'scheduledAutoDm';

create function public.pending_scheduled_instagram_auto_dms(p_limit integer default 100)
returns table (
  post_id uuid,
  connection_id uuid,
  provider text,
  status text,
  remote_post_id text,
  published_at timestamptz,
  provider_settings jsonb,
  user_id uuid
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select target.post_id, target.connection_id, target.provider, target.status,
    target.remote_post_id, target.published_at, target.provider_settings, post.user_id
  from public.social_post_targets target
  join public.social_posts post on post.id = target.post_id
  where target.provider = 'instagram'
    and target.status = 'published'
    and target.remote_post_id is not null
    and target.provider_settings ? 'scheduledAutoDm'
    and jsonb_typeof(target.provider_settings -> 'scheduledAutoDm') = 'object'
    and not exists (
      select 1 from public.instagram_dm_automations automation
      where automation.scheduled_post_id = target.post_id
        and automation.connection_id = target.connection_id
    )
  order by target.published_at
  limit least(greatest(p_limit, 1), 500);
$$;

revoke all on function public.pending_scheduled_instagram_auto_dms(integer) from public, anon, authenticated;
grant execute on function public.pending_scheduled_instagram_auto_dms(integer) to service_role;

create function public.delete_instagram_dm_automation_owned(p_user_id uuid, p_automation_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_post_id uuid;
  v_connection_id uuid;
begin
  select automation.scheduled_post_id, automation.connection_id
    into v_post_id, v_connection_id
  from public.instagram_dm_automations automation
  where automation.id = p_automation_id and automation.user_id = p_user_id
  for update;
  if not found then return false; end if;

  if v_post_id is not null then
    update public.social_post_targets target
    set provider_settings = target.provider_settings - 'scheduledAutoDm'
    where target.post_id = v_post_id and target.connection_id = v_connection_id;
  end if;

  delete from public.instagram_dm_automations automation
  where automation.id = p_automation_id and automation.user_id = p_user_id;
  return true;
end;
$$;

revoke all on function public.delete_instagram_dm_automation_owned(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_instagram_dm_automation_owned(uuid, uuid) to service_role;
