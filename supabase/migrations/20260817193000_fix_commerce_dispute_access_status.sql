-- Repair the deployed dispute RPC without rewriting migration history. The
-- original CASE resolves to text, which PostgreSQL cannot assign to the enum.
do $migration$
declare
  function_signature constant regprocedure :=
    'public.apply_commerce_dispute(text,text,text,text,text,text,integer,text,jsonb,timestamptz)'::regprocedure;
  original_definition text := pg_get_functiondef(function_signature);
  repaired_definition text;
  expired_branch_count integer;
  active_branch_count integer;
begin
  expired_branch_count :=
    (length(original_definition) - length(replace(original_definition, 'then ''expired''', '')))
    / length('then ''expired''');
  active_branch_count :=
    (length(original_definition) - length(replace(original_definition, 'else ''active''', '')))
    / length('else ''active''');

  if expired_branch_count <> 1 or active_branch_count <> 1 then
    raise exception 'apply_commerce_dispute definition did not match the expected vulnerable expression';
  end if;

  repaired_definition := replace(
    replace(
      original_definition,
      'then ''expired''',
      'then ''expired''::public.commerce_access_status'
    ),
    'else ''active''',
    'else ''active''::public.commerce_access_status'
  );

  execute repaired_definition;
end;
$migration$;
