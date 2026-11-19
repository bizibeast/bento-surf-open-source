-- Run as an admin against a local stack after applying the migration.
begin;
insert into public.profiles (id, username) values
  ('10000000-0000-4000-8000-000000000011', 'benny_provider_a'),
  ('10000000-0000-4000-8000-000000000012', 'benny_provider_b');
insert into auth.users (id, email) values
  ('20000000-0000-4000-8000-000000000011', 'benny-provider-a@example.test'),
  ('20000000-0000-4000-8000-000000000012', 'benny-provider-b@example.test');

set local role service_role;
do $$
declare
  workspace_a uuid := '10000000-0000-4000-8000-000000000011';
  workspace_b uuid := '10000000-0000-4000-8000-000000000012';
  owner_a uuid := '20000000-0000-4000-8000-000000000011';
  owner_b uuid := '20000000-0000-4000-8000-000000000012';
  first_provider uuid;
  second_provider uuid;
begin
  insert into public.benny_ai_providers(workspace_id, owner_id, name, model, encrypted_api_key)
  values (workspace_a, owner_a, 'One', 'author/model', 'ciphertext')
  returning id into first_provider;
  insert into public.benny_ai_providers(workspace_id, owner_id, name, model, encrypted_api_key)
  values (workspace_a, owner_a, 'Two', 'author/other-model', 'ciphertext')
  returning id into second_provider;

  insert into public.benny_ai_provider_defaults values (workspace_a, owner_a, first_provider);
  insert into public.benny_ai_provider_defaults values (workspace_a, owner_a, second_provider)
  on conflict (workspace_id, owner_id) do update set provider_id = excluded.provider_id;
  if (select provider_id from public.benny_ai_provider_defaults) is distinct from second_provider then
    raise exception 'Default provider did not update';
  end if;
  begin
    insert into public.benny_ai_provider_defaults values (workspace_b, owner_a, second_provider);
    raise exception 'Cross-workspace default accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.benny_ai_provider_defaults values (workspace_a, owner_b, second_provider);
    raise exception 'Cross-owner default accepted';
  exception when foreign_key_violation then null;
  end;
  delete from public.benny_ai_providers where id = second_provider;
  if exists (select from public.benny_ai_provider_defaults) then
    raise exception 'Revoked credential retained as default';
  end if;
  if (select count(*) from public.benny_ai_providers) <> 1 then
    raise exception 'Revocation removed other connections';
  end if;
end $$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform 1 from public.benny_ai_providers;
    raise exception 'Authenticated access to credential table';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.benny_ai_provider_defaults;
    raise exception 'Authenticated access to defaults table';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role anon;
do $$
begin
  begin
    perform 1 from public.benny_ai_providers;
    raise exception 'Anonymous access to credential table';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
