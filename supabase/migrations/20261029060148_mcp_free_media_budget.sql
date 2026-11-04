-- Each MCP media resolution reserves one unit before the Cobalt request.
-- URL transcripts reserve two units to cover the bounded TikTok fallback.
-- MCP requests use an authenticated workspace and never retry automatically.
insert into public.provider_budget_policies
  (resource, enabled, daily_limit, monthly_limit, workspace_daily_limit, workspace_monthly_limit)
values
  ('mcp_media_resolutions', true, 500, 5000, 25, 250)
on conflict (resource) do nothing;
