create index content_source_records_connection_owner_idx
  on public.content_source_records(connection_id, user_id);
