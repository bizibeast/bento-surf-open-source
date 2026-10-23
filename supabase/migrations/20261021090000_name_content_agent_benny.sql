begin;

alter table public.content_agent_preferences
  alter column display_name set default 'Benny';

with renamed as (
  update public.content_agent_preferences
  set display_name = 'Benny'
  where display_name = 'Bento'
  returning user_id
)
update public.content_agent_threads as thread
set title = 'Benny'
from renamed
where thread.user_id = renamed.user_id
  and thread.kind = 'agent';

commit;
