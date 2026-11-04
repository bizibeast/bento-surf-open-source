begin;

drop trigger if exists social_connection_preserve_post_history on public.social_connections;
create trigger social_connection_preserve_post_history
  before delete on public.social_connections
  for each row execute function private.preserve_social_post_history_on_disconnect();

commit;
