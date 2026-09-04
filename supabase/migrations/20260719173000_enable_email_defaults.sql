-- New accounts receive all optional Bento emails by default. Existing users who
-- explicitly unsubscribed keep that choice; only untouched legacy defaults are
-- moved to the new enabled state.

alter table public.email_preferences
  alter column product_updates set default true,
  alter column weekly_digest set default true;

insert into public.email_preferences (user_id, product_updates, weekly_digest)
select id, true, true
from auth.users
on conflict (user_id) do nothing;

update public.email_preferences
set
  product_updates = true,
  weekly_digest = true,
  updated_at = now()
where not product_updates
  and not weekly_digest
  and marketing_unsubscribed_at is null;

notify pgrst, 'reload schema';
