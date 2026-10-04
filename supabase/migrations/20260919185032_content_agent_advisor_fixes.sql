drop policy creator_content_profiles_owner_all on public.creator_content_profiles;
create policy creator_content_profiles_owner_all
  on public.creator_content_profiles for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy creator_brain_items_owner_all on public.creator_brain_items;
create policy creator_brain_items_owner_all
  on public.creator_brain_items for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy creator_content_recommendations_owner_all on public.creator_content_recommendations;
create policy creator_content_recommendations_owner_all
  on public.creator_content_recommendations for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy content_agent_threads_owner_all on public.content_agent_threads;
create policy content_agent_threads_owner_all
  on public.content_agent_threads for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy content_agent_messages_owner_all on public.content_agent_messages;
create policy content_agent_messages_owner_all
  on public.content_agent_messages for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy content_routines_owner_all on public.content_routines;
create policy content_routines_owner_all
  on public.content_routines for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy content_routine_runs_owner_select on public.content_routine_runs;
create policy content_routine_runs_owner_select
  on public.content_routine_runs for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy content_connections_owner_all on public.content_connections;
create policy content_connections_owner_all
  on public.content_connections for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create index content_agent_messages_thread_owner_idx
  on public.content_agent_messages(thread_id, user_id);
create index content_agent_messages_user_created_idx
  on public.content_agent_messages(user_id, created_at desc);
create index creator_content_recommendations_insight_idx
  on public.creator_content_recommendations(content_insight_id)
  where content_insight_id is not null;
create index creator_content_recommendations_trend_idx
  on public.creator_content_recommendations(trend_brief_id)
  where trend_brief_id is not null;
create index telegram_actions_user_idx
  on public.telegram_actions(user_id);
