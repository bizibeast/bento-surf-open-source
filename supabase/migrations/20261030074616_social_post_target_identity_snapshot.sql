begin;

create or replace function private.snapshot_social_post_target_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- ON DELETE SET NULL must retain the saved identity.
  if new.connection_id is not null then
    select connection.provider_handle,
           connection.provider_display_name,
           connection.provider_user_id
      into new.account_handle_snapshot,
           new.account_display_name_snapshot,
           new.provider_user_id_snapshot
    from public.social_connections connection
    where connection.id = new.connection_id;
  end if;
  return new;
end;
$$;
revoke all on function private.snapshot_social_post_target_identity()
  from public, anon, authenticated;
drop trigger if exists social_post_target_identity_snapshot on public.social_post_targets;
create trigger social_post_target_identity_snapshot
  before insert or update of connection_id on public.social_post_targets
  for each row execute function private.snapshot_social_post_target_identity();

commit;
