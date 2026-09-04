-- Keep creator-facing webinar registration reads and attendance updates fast as
-- registration volume grows.

create index if not exists commerce_webinar_registrations_order_idx
  on public.commerce_webinar_registrations(order_id);

drop policy if exists commerce_webinar_registrations_creator_read
  on public.commerce_webinar_registrations;
create policy commerce_webinar_registrations_creator_read
  on public.commerce_webinar_registrations for select
  to authenticated
  using ((select auth.uid()) = creator_id);

drop policy if exists commerce_webinar_registrations_creator_update
  on public.commerce_webinar_registrations;
create policy commerce_webinar_registrations_creator_update
  on public.commerce_webinar_registrations for update
  to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);
