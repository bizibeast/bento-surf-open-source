-- Trigger functions execute through their owning triggers and must never be exposed
-- as PostgREST RPC endpoints.
revoke all on function public.commerce_count_paid_order() from public, anon, authenticated;
revoke all on function public.enforce_custom_domain_capacity() from public, anon, authenticated;
revoke all on function public.rollup_block_click_inserts() from public, anon, authenticated;
revoke all on function public.rollup_profile_view_inserts() from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end
$$;

-- Public buckets serve objects without a SELECT policy. Removing this broad
-- policy prevents clients from enumerating every legacy avatar object.
drop policy if exists "avatars_public_read" on storage.objects;

-- Cache auth.uid() once per statement instead of evaluating it for every row.
alter policy analytics_block_owner_read on public.analytics_block_daily
  using ((select auth.uid()) = user_id);
alter policy analytics_daily_owner_read on public.analytics_daily
  using ((select auth.uid()) = user_id);
alter policy analytics_dimensions_owner_read on public.analytics_daily_dimensions
  using ((select auth.uid()) = user_id);
alter policy analytics_hourly_owner_read on public.analytics_hourly
  using ((select auth.uid()) = user_id);
alter policy bc_owner_read on public.block_clicks
  using ((select auth.uid()) = user_id);
alter policy blocks_owner_all on public.blocks
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
alter policy commerce_bookings_owner_read on public.commerce_bookings
  using ((select auth.uid()) = creator_id);
alter policy commerce_comments_owner_all on public.commerce_community_comments
  using (
    (select auth.uid()) = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_comments.product_id
        and product.creator_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_comments.product_id
        and product.creator_id = (select auth.uid())
    )
    and exists (
      select 1 from public.commerce_community_posts post
      where post.id = commerce_community_comments.post_id
        and post.product_id = commerce_community_comments.product_id
    )
  );
alter policy commerce_posts_owner_all on public.commerce_community_posts
  using (
    (select auth.uid()) = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_posts.product_id
        and product.creator_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_community_posts.product_id
        and product.creator_id = (select auth.uid())
    )
  );
alter policy commerce_lessons_owner_all on public.commerce_course_lessons
  using (
    (select auth.uid()) = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_course_lessons.product_id
        and product.creator_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = creator_id
    and exists (
      select 1 from public.commerce_products product
      where product.id = commerce_course_lessons.product_id
        and product.creator_id = (select auth.uid())
    )
  );
alter policy commerce_leads_owner_read on public.commerce_leads
  using ((select auth.uid()) = creator_id);
alter policy commerce_orders_owner_read on public.commerce_orders
  using ((select auth.uid()) = creator_id);
alter policy commerce_payouts_owner_read on public.commerce_payout_requests
  using ((select auth.uid()) = creator_id);
alter policy commerce_product_provider_refs_owner_read on public.commerce_product_provider_refs
  using ((select auth.uid()) = creator_id);
alter policy commerce_products_owner_read on public.commerce_products
  using ((select auth.uid()) = creator_id);
alter policy custom_domains_owner_read on public.custom_domains
  using ((select auth.uid()) = user_id);
alter policy email_preferences_owner_insert on public.email_preferences
  with check ((select auth.uid()) = user_id);
alter policy email_preferences_owner_read on public.email_preferences
  using ((select auth.uid()) = user_id);
alter policy email_preferences_owner_update on public.email_preferences
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
alter policy email_signups_owner_read on public.email_signups
  using ((select auth.uid()) = owner_user_id);
alter policy pages_owner_all on public.pages
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
alter policy pv_owner_read on public.profile_views
  using ((select auth.uid()) = user_id);
alter policy profiles_owner_insert on public.profiles
  with check ((select auth.uid()) = id);
alter policy profiles_owner_update on public.profiles
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
alter policy subs_owner_read on public.subscriptions
  using ((select auth.uid()) = user_id);
alter policy tips_recipient_read on public.tips
  using ((select auth.uid()) = recipient_user_id);
alter policy user_roles_own_read on public.user_roles
  using ((select auth.uid()) = user_id);

-- Avoid overlapping SELECT policies while preserving full owner writes.
drop policy if exists commerce_products_owner_write on public.commerce_products;
create policy commerce_products_owner_insert
  on public.commerce_products for insert to authenticated
  with check ((select auth.uid()) = creator_id);
create policy commerce_products_owner_update
  on public.commerce_products for update to authenticated
  using ((select auth.uid()) = creator_id)
  with check ((select auth.uid()) = creator_id);
create policy commerce_products_owner_delete
  on public.commerce_products for delete to authenticated
  using ((select auth.uid()) = creator_id);

-- Cover every foreign key reported by the database advisor. These indexes make
-- deletes, joins, cleanup jobs, and creator dashboards predictable at scale.
create index if not exists analytics_block_daily_block_id_idx
  on public.analytics_block_daily (block_id);
create index if not exists block_clicks_block_id_idx
  on public.block_clicks (block_id);
create index if not exists commerce_access_grants_creator_id_idx
  on public.commerce_access_grants (creator_id);
create index if not exists commerce_affiliate_clicks_product_id_idx
  on public.commerce_affiliate_clicks (product_id);
create index if not exists commerce_bookings_order_id_idx
  on public.commerce_bookings (order_id);
create index if not exists commerce_bookings_product_id_idx
  on public.commerce_bookings (product_id);
create index if not exists commerce_community_comments_access_grant_id_idx
  on public.commerce_community_comments (access_grant_id);
create index if not exists commerce_community_comments_creator_id_idx
  on public.commerce_community_comments (creator_id);
create index if not exists commerce_community_comments_product_id_idx
  on public.commerce_community_comments (product_id);
create index if not exists commerce_community_posts_access_grant_id_idx
  on public.commerce_community_posts (access_grant_id);
create index if not exists commerce_community_posts_creator_id_idx
  on public.commerce_community_posts (creator_id);
create index if not exists commerce_course_lessons_creator_id_idx
  on public.commerce_course_lessons (creator_id);
create index if not exists commerce_payment_sessions_connection_id_idx
  on public.commerce_payment_sessions (connection_id);
create index if not exists commerce_payment_sessions_product_id_idx
  on public.commerce_payment_sessions (product_id);
create index if not exists payment_oauth_states_creator_id_idx
  on public.payment_oauth_states (creator_id);
create index if not exists social_oauth_states_user_id_idx
  on public.social_oauth_states (user_id);
