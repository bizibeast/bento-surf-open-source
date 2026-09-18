begin;

drop policy if exists page_system_item_layouts_owner_write
  on public.page_system_item_layouts;
drop policy if exists page_system_item_layouts_owner_insert
  on public.page_system_item_layouts;
drop policy if exists page_system_item_layouts_owner_update
  on public.page_system_item_layouts;
drop policy if exists page_system_item_layouts_owner_delete
  on public.page_system_item_layouts;

create policy page_system_item_layouts_owner_insert
  on public.page_system_item_layouts for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  );

create policy page_system_item_layouts_owner_update
  on public.page_system_item_layouts for update
  to authenticated
  using (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  );

create policy page_system_item_layouts_owner_delete
  on public.page_system_item_layouts for delete
  to authenticated
  using (
    exists (
      select 1
      from public.pages page
      where page.id = page_id
        and page.user_id = (select auth.uid())
    )
  );

revoke all on function public.reorder_creator_pages(uuid[]) from anon;
revoke all on function public.replace_page_system_item_layout(uuid, jsonb) from anon;

notify pgrst, 'reload schema';

commit;
