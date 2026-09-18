begin;

alter function public.reorder_creator_pages(uuid[]) security invoker;
alter function public.replace_page_system_item_layout(uuid, jsonb) security invoker;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.page_system_item_layouts'::regclass
      and conname = 'page_system_item_layouts_page_id_item_key_key'
  ) then
    alter table public.page_system_item_layouts
      drop constraint page_system_item_layouts_page_id_item_key_key;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.page_system_item_layouts'::regclass
      and contype = 'p'
  ) then
    alter table public.page_system_item_layouts
      add primary key (page_id, item_key);
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
