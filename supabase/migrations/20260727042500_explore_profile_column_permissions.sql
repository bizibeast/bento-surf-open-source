-- Profile access is intentionally column-scoped. The Explore fields were added
-- after the original allowlists, so grant only these two columns and continue
-- relying on profiles_owner_read / profiles_owner_update for row ownership.
grant select (show_in_explore, explore_category)
  on public.profiles to authenticated;

grant update (show_in_explore, explore_category)
  on public.profiles to authenticated;

notify pgrst, 'reload schema';
