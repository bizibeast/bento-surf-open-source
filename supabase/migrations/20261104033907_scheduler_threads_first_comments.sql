-- Service-only publishing state; never accepted through editable provider settings.
alter table public.social_post_targets
  add column publish_progress jsonb,
  add constraint social_publish_progress_object check (
    publish_progress is null or jsonb_typeof(publish_progress) = 'object'
  );

-- Editing replaces targets in save_social_post_atomic. Do not erase checkpoints
-- for a partially published thread/comment sequence, or an uncertain write.
create function public.guard_social_publish_progress_edit()
returns trigger language plpgsql security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status in ('draft', 'scheduled') and exists (
    select 1 from public.social_post_targets target
    where target.post_id = old.id and target.publish_progress is not null
      and (coalesce(jsonb_array_length(target.publish_progress -> 'completed'), 0) > 0
        or (target.publish_progress -> 'pending') <> 'null'::jsonb)
  ) then
    raise exception 'This post has already been sent in whole or in part. Retry the failed destination instead of editing it.' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_social_publish_progress_edit() from public, anon, authenticated;
grant execute on function public.guard_social_publish_progress_edit() to service_role;
create trigger guard_social_publish_progress_edit
  before update on public.social_posts
  for each row execute function public.guard_social_publish_progress_edit();
