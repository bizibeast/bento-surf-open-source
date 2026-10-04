begin;

do $$
declare
  target record;
begin
  for target in
    select distinct compatibility.tablename
    from pg_policies compatibility
    where compatibility.schemaname = 'public'
      and compatibility.policyname = 'workspace_member_access'
      and exists (
        select 1
        from pg_policies replacement
        where replacement.schemaname = compatibility.schemaname
          and replacement.tablename = compatibility.tablename
          and replacement.policyname <> 'workspace_member_access'
          and (
            replacement.qual ilike '%private.is_workspace_member%'
            or replacement.with_check ilike '%private.is_workspace_member%'
          )
      )
  loop
    execute format(
      'drop policy workspace_member_access on public.%I',
      target.tablename
    );
  end loop;
end
$$;

commit;
