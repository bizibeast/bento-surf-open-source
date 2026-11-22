alter table public.content_connections
  add column mcp_folders_enabled boolean not null default false,
  add column mcp_folders_last_attempt_at timestamptz,
  add column mcp_folders_last_success_at timestamptz;

comment on column public.content_connections.mcp_folders_enabled is
  'Personal workspace owner consent for the Bento MCP tool to list selected Granola folder names.';
