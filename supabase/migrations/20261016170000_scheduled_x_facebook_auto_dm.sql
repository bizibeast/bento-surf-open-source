-- Scheduler automations are attached only after confirmed publication.
alter table public.twitter_dm_automations
  add column if not exists scheduled_post_id uuid references public.social_posts(id) on delete set null,
  add column if not exists source_post_id text check (length(source_post_id) between 1 and 255);
alter table public.facebook_dm_automations
  add column if not exists scheduled_post_id uuid references public.social_posts(id) on delete set null;

create unique index if not exists twitter_dm_automations_scheduled_post_connection_idx
  on public.twitter_dm_automations(scheduled_post_id, connection_id) where scheduled_post_id is not null;
create unique index if not exists facebook_dm_automations_scheduled_post_connection_idx
  on public.facebook_dm_automations(scheduled_post_id, connection_id) where scheduled_post_id is not null;
create index if not exists social_post_targets_scheduled_x_facebook_dm_idx
  on public.social_post_targets(published_at)
  where provider in ('twitter', 'facebook') and status = 'published'
    and jsonb_typeof(provider_settings -> 'scheduledAutoDm') = 'object';

create or replace function public.pending_scheduled_post_auto_dms(p_limit integer default 50)
returns table (post_id uuid, connection_id uuid, provider text, status text,
  remote_post_id text, published_at timestamptz, provider_settings jsonb, user_id uuid)
language sql security invoker set search_path = public, pg_temp as $$
  select t.post_id, t.connection_id, t.provider, t.status, t.remote_post_id,
    t.published_at, t.provider_settings, p.user_id
  from public.social_post_targets t
  join public.social_posts p on p.id = t.post_id
  join public.social_connections c on c.id = t.connection_id and c.user_id = p.user_id
  where t.provider in ('twitter', 'facebook') and t.status = 'published'
    and t.remote_post_id is not null
    and jsonb_typeof(t.provider_settings -> 'scheduledAutoDm') = 'object'
    -- A bounded recent window avoids repeatedly scanning years of old drafts.
    and t.published_at > now() - interval '7 days'
    and c.status = 'active' and not c.reauth_required and c.connection_health = 'healthy'
    and c.last_verified_at > now() - interval '48 hours'
    and (c.token_expires_at is null or c.token_expires_at > now())
    and ((t.provider = 'twitter' and c.token_expires_at is not null
      and c.scopes @> array['tweet.read','users.read','dm.read','dm.write','offline.access']::text[]
      and c.webhook_fields @> array['direct_messages','mentions']::text[]
      and not exists (select 1 from public.twitter_dm_automations a where a.scheduled_post_id = t.post_id and a.connection_id = t.connection_id))
    or (t.provider = 'facebook'
      and c.scopes @> array['pages_show_list','pages_read_user_content','pages_read_engagement','pages_manage_metadata','pages_manage_engagement','pages_messaging']::text[]
      and c.webhook_fields @> array['feed','messages','messaging_postbacks']::text[]
      and not exists (select 1 from public.facebook_dm_automations a where a.scheduled_post_id = t.post_id and a.connection_id = t.connection_id)))
  order by t.published_at
  limit least(greatest(p_limit, 1), 100);
$$;
revoke all on function public.pending_scheduled_post_auto_dms(integer) from public, anon, authenticated;
grant execute on function public.pending_scheduled_post_auto_dms(integer) to service_role;

-- Deleting a generated rule must not recreate it on the next reconciliation.
-- A trigger also covers older clients and the existing dashboard delete handlers.
create or replace function public.clear_deleted_scheduled_post_auto_dm()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if old.scheduled_post_id is not null then
    update public.social_post_targets t
    set provider_settings = t.provider_settings - 'scheduledAutoDm'
    where t.post_id = old.scheduled_post_id and t.connection_id = old.connection_id
      and t.provider = case when tg_table_name = 'twitter_dm_automations' then 'twitter' else 'facebook' end
      and exists (select 1 from public.social_posts p where p.id = t.post_id and p.user_id = old.user_id);
  end if;
  return old;
end;
$$;
revoke all on function public.clear_deleted_scheduled_post_auto_dm() from public, anon, authenticated;
grant execute on function public.clear_deleted_scheduled_post_auto_dm() to service_role;
create trigger twitter_dm_clear_scheduled_config before delete on public.twitter_dm_automations
  for each row execute function public.clear_deleted_scheduled_post_auto_dm();
create trigger facebook_dm_clear_scheduled_config before delete on public.facebook_dm_automations
  for each row execute function public.clear_deleted_scheduled_post_auto_dm();
