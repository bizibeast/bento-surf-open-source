-- Follow-up hardening after the staging advisor review.

create index audience_contacts_customer_idx
  on public.audience_contacts(customer_id);
create index audience_events_product_idx
  on public.audience_events(product_id);
create index audience_events_order_idx
  on public.audience_events(order_id);
create index audience_events_booking_idx
  on public.audience_events(booking_id);
create index commerce_customer_magic_links_customer_idx
  on public.commerce_customer_magic_links(customer_id);
create index commerce_customer_sessions_customer_idx
  on public.commerce_customer_sessions(customer_id);

drop policy if exists audience_contacts_owner_read on public.audience_contacts;
create policy audience_contacts_owner_read
  on public.audience_contacts for select
  to authenticated
  using ((select auth.uid()) = creator_id);

drop policy if exists audience_events_owner_read on public.audience_events;
create policy audience_events_owner_read
  on public.audience_events for select
  to authenticated
  using ((select auth.uid()) = creator_id);

-- These tables are service-only. Explicit deny policies document that boundary
-- for the database linter in addition to the revoked Data API grants.
create policy commerce_customers_service_only
  on public.commerce_customers for all
  to anon, authenticated
  using (false)
  with check (false);

create policy commerce_customer_magic_links_service_only
  on public.commerce_customer_magic_links for all
  to anon, authenticated
  using (false)
  with check (false);

create policy commerce_customer_sessions_service_only
  on public.commerce_customer_sessions for all
  to anon, authenticated
  using (false)
  with check (false);
