begin;

create temporary table workspace_owner_columns (
  table_name text primary key,
  column_name text not null
) on commit drop;

insert into workspace_owner_columns (table_name, column_name) values
  ('profiles', 'id'),
  ('profile_username_aliases', 'user_id'),
  ('pages', 'user_id'),
  ('blocks', 'user_id'),
  ('custom_domains', 'user_id'),
  ('subscriptions', 'user_id'),
  ('complimentary_plan_grants', 'user_id'),
  ('analytics_hourly', 'user_id'),
  ('analytics_daily', 'user_id'),
  ('analytics_daily_dimensions', 'user_id'),
  ('analytics_block_daily', 'user_id'),
  ('analytics_daily_visitors', 'user_id'),
  ('profile_visit_totals', 'user_id'),
  ('profile_views', 'user_id'),
  ('block_clicks', 'user_id'),
  ('social_connections', 'user_id'),
  ('social_oauth_states', 'user_id'),
  ('social_posts', 'user_id'),
  ('social_posting_schedules', 'user_id'),
  ('social_analytics_snapshots', 'user_id'),
  ('social_analytics_history', 'user_id'),
  ('social_content_insights', 'user_id'),
  ('instagram_dm_automations', 'user_id'),
  ('instagram_dm_runs', 'user_id'),
  ('facebook_dm_automations', 'user_id'),
  ('facebook_dm_runs', 'user_id'),
  ('twitter_dm_automations', 'user_id'),
  ('creator_content_profiles', 'user_id'),
  ('creator_brain_items', 'user_id'),
  ('creator_content_recommendations', 'user_id'),
  ('content_agent_threads', 'user_id'),
  ('content_agent_messages', 'user_id'),
  ('content_routines', 'user_id'),
  ('content_routine_runs', 'user_id'),
  ('content_connections', 'user_id'),
  ('content_connection_states', 'user_id'),
  ('content_source_records', 'user_id'),
  ('telegram_actions', 'user_id'),
  ('audience_contacts', 'creator_id'),
  ('audience_events', 'creator_id'),
  ('audience_consent_events', 'creator_id'),
  ('audience_lists', 'creator_id'),
  ('audience_campaigns', 'creator_id'),
  ('newsletter_publications', 'creator_id'),
  ('email_marketing_send_reservations', 'creator_id'),
  ('email_preferences', 'user_id'),
  ('email_signups', 'owner_user_id'),
  ('commerce_products', 'creator_id'),
  ('commerce_orders', 'creator_id'),
  ('commerce_access_grants', 'creator_id'),
  ('commerce_leads', 'creator_id'),
  ('commerce_course_lessons', 'creator_id'),
  ('commerce_bookings', 'creator_id'),
  ('commerce_community_posts', 'creator_id'),
  ('commerce_community_comments', 'creator_id'),
  ('commerce_community_notifications', 'creator_id'),
  ('commerce_discount_codes', 'creator_id'),
  ('commerce_order_bumps', 'creator_id'),
  ('commerce_discount_redemptions', 'creator_id'),
  ('commerce_subscription_access', 'creator_id'),
  ('commerce_download_events', 'creator_id'),
  ('commerce_webinar_registrations', 'creator_id'),
  ('commerce_priority_dm_requests', 'creator_id'),
  ('creator_payment_accounts', 'creator_id'),
  ('commerce_payout_requests', 'creator_id'),
  ('payment_oauth_states', 'creator_id'),
  ('commerce_payment_sessions', 'creator_id'),
  ('commerce_product_provider_refs', 'creator_id'),
  ('booking_calendar_oauth_states', 'user_id'),
  ('booking_calendar_connections', 'user_id'),
  ('booking_availability', 'creator_id'),
  ('booking_fathom_oauth_states', 'user_id'),
  ('booking_fathom_connections', 'user_id'),
  ('booking_reviews', 'creator_id'),
  ('billing_events', 'user_id'),
  ('payments', 'user_id'),
  ('refunds', 'user_id'),
  ('tips', 'recipient_user_id'),
  ('referral_accounts', 'user_id');

do $$
declare
  owner record;
  foreign_key record;
  delete_action text;
  update_action text;
begin
  for owner in
    select *
    from workspace_owner_columns
    where table_name <> 'profiles'
      and to_regclass('public.' || table_name) is not null
  loop
    for foreign_key in
      select constraint_row.conname, constraint_row.confdeltype, constraint_row.confupdtype
      from pg_constraint constraint_row
      join pg_class source_table on source_table.oid = constraint_row.conrelid
      join pg_namespace source_schema on source_schema.oid = source_table.relnamespace
      join pg_attribute source_column
        on source_column.attrelid = source_table.oid
       and source_column.attnum = constraint_row.conkey[1]
      where constraint_row.contype = 'f'
        and cardinality(constraint_row.conkey) = 1
        and source_schema.nspname = 'public'
        and source_table.relname = owner.table_name
        and source_column.attname = owner.column_name
        and constraint_row.confrelid = 'auth.users'::regclass
    loop
      delete_action := case foreign_key.confdeltype
        when 'c' then ' on delete cascade'
        when 'n' then ' on delete set null'
        when 'd' then ' on delete set default'
        when 'r' then ' on delete restrict'
        else ''
      end;
      update_action := case foreign_key.confupdtype
        when 'c' then ' on update cascade'
        when 'n' then ' on update set null'
        when 'd' then ' on update set default'
        when 'r' then ' on update restrict'
        else ''
      end;

      execute format(
        'alter table public.%I drop constraint %I',
        owner.table_name,
        foreign_key.conname
      );
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.profiles(id)%s%s',
        owner.table_name,
        owner.table_name || '_' || owner.column_name || '_workspace_fkey',
        owner.column_name,
        delete_action,
        update_action
      );
    end loop;
  end loop;
end
$$;

do $$
declare
  owner record;
begin
  for owner in
    select *
    from workspace_owner_columns
    where to_regclass('public.' || table_name) is not null
  loop
    if not exists (
      select 1
      from pg_index index_row
      join pg_class table_row on table_row.oid = index_row.indrelid
      join pg_namespace table_schema on table_schema.oid = table_row.relnamespace
      join pg_attribute column_row
        on column_row.attrelid = table_row.oid
       and column_row.attnum = index_row.indkey[0]
      where table_schema.nspname = 'public'
        and table_row.relname = owner.table_name
        and column_row.attname = owner.column_name
        and index_row.indisvalid
    ) then
      execute format(
        'create index %I on public.%I (%I)',
        owner.table_name || '_' || owner.column_name || '_workspace_idx',
        owner.table_name,
        owner.column_name
      );
    end if;
  end loop;
end
$$;

do $$
declare
  owner record;
begin
  for owner in
    select owner_columns.*
    from workspace_owner_columns owner_columns
    join pg_class table_row on table_row.relname = owner_columns.table_name
    join pg_namespace table_schema on table_schema.oid = table_row.relnamespace
    where table_schema.nspname = 'public'
      and table_row.relrowsecurity
  loop
    execute format(
      'drop policy if exists workspace_member_access on public.%I',
      owner.table_name
    );
    execute format(
      'create policy workspace_member_access on public.%I for all to authenticated using (private.is_workspace_member(%I)) with check (private.is_workspace_member(%I))',
      owner.table_name,
      owner.column_name,
      owner.column_name
    );
  end loop;
end
$$;

create or replace function pg_temp.workspace_policy_expression(expression text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          expression,
          '\(\s*select\s+auth\.uid\(\)(?:\s+as\s+uid)?\s*\)\s*=\s*([a-z_][a-z0-9_.]*)',
          'private.is_workspace_member(\1)',
          'gi'
        ),
        '([a-z_][a-z0-9_.]*)\s*=\s*\(\s*select\s+auth\.uid\(\)(?:\s+as\s+uid)?\s*\)',
        'private.is_workspace_member(\1)',
        'gi'
      ),
      'auth\.uid\(\)\s*=\s*([a-z_][a-z0-9_.]*)',
      'private.is_workspace_member(\1)',
      'gi'
    ),
    '([a-z_][a-z0-9_.]*)\s*=\s*auth\.uid\(\)',
    'private.is_workspace_member(\1)',
    'gi'
  );
$$;

create temporary table workspace_owned_tables (
  table_name text primary key
) on commit drop;

insert into workspace_owned_tables (table_name)
with recursive owned(table_oid, table_name) as (
  select table_row.oid, owner.table_name collate "C"
  from workspace_owner_columns owner
  join pg_class table_row on table_row.relname = owner.table_name
  join pg_namespace table_schema on table_schema.oid = table_row.relnamespace
  where table_schema.nspname = 'public'
  union
  select child_table.oid, child_table.relname
  from owned parent
  join pg_constraint foreign_key
    on foreign_key.confrelid = parent.table_oid
   and foreign_key.contype = 'f'
  join pg_class child_table on child_table.oid = foreign_key.conrelid
  join pg_namespace child_schema on child_schema.oid = child_table.relnamespace
  where child_schema.nspname = 'public'
)
select distinct table_name from owned;

do $$
declare
  policy_row record;
  roles_sql text;
  using_sql text;
  check_sql text;
  statement text;
begin
  for policy_row in
    select policy.*
    from pg_policies policy
    join workspace_owned_tables owned on owned.table_name = policy.tablename
    where policy.schemaname = 'public'
      and (policy.qual ilike '%auth.uid%' or policy.with_check ilike '%auth.uid%')
  loop
    select string_agg(quote_ident(role_name), ', ')
    into roles_sql
    from unnest(policy_row.roles) role_name;
    using_sql := pg_temp.workspace_policy_expression(policy_row.qual);
    check_sql := pg_temp.workspace_policy_expression(policy_row.with_check);
    statement := format(
      'alter policy %I on public.%I to %s',
      policy_row.policyname,
      policy_row.tablename,
      roles_sql
    );
    if using_sql is not null then
      statement := statement || format(' using (%s)', using_sql);
    end if;
    if check_sql is not null then
      statement := statement || format(' with check (%s)', check_sql);
    end if;
    execute statement;
  end loop;
end
$$;

do $$
declare
  invalid_owner text;
begin
  select owner.table_name || '.' || owner.column_name
  into invalid_owner
  from workspace_owner_columns owner
  join pg_class source_table on source_table.relname = owner.table_name
  join pg_namespace source_schema on source_schema.oid = source_table.relnamespace
  join pg_constraint constraint_row
    on constraint_row.conrelid = source_table.oid
   and constraint_row.contype = 'f'
  join pg_attribute source_column
    on source_column.attrelid = source_table.oid
   and source_column.attnum = any(constraint_row.conkey)
  where source_schema.nspname = 'public'
    and source_column.attname = owner.column_name
    and constraint_row.confrelid = 'auth.users'::regclass
  limit 1;

  if invalid_owner is not null then
    raise exception 'workspace owner column still references auth.users: %', invalid_owner;
  end if;

  select owner.table_name || '.' || owner.column_name
  into invalid_owner
  from workspace_owner_columns owner
  where owner.table_name <> 'profiles'
    and to_regclass('public.' || owner.table_name) is not null
    and not exists (
      select 1
      from pg_class source_table
      join pg_namespace source_schema on source_schema.oid = source_table.relnamespace
      join pg_constraint constraint_row
        on constraint_row.conrelid = source_table.oid
       and constraint_row.contype = 'f'
      join pg_attribute source_column
        on source_column.attrelid = source_table.oid
       and source_column.attnum = any(constraint_row.conkey)
      where source_schema.nspname = 'public'
        and source_table.relname = owner.table_name
        and source_column.attname = owner.column_name
        and constraint_row.confrelid = 'public.profiles'::regclass
    )
  limit 1;

  if invalid_owner is not null then
    raise exception 'workspace owner column missing profiles foreign key: %', invalid_owner;
  end if;

  select owner.table_name || '.' || owner.column_name
  into invalid_owner
  from workspace_owner_columns owner
  join pg_class table_row on table_row.relname = owner.table_name
  join pg_namespace table_schema on table_schema.oid = table_row.relnamespace
  where table_schema.nspname = 'public'
    and table_row.relrowsecurity
    and not exists (
      select 1
      from pg_policies policy
      where policy.schemaname = 'public'
        and policy.tablename = owner.table_name
        and policy.policyname = 'workspace_member_access'
        and policy.qual ilike '%private.is_workspace_member%'
        and policy.with_check ilike '%private.is_workspace_member%'
    )
  limit 1;

  if invalid_owner is not null then
    raise exception 'workspace owner table missing membership policy: %', invalid_owner;
  end if;
end
$$;

commit;
