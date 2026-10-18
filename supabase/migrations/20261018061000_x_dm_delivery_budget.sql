-- Separate fail-closed outbound X Auto DM limits from ordinary X publishing.
-- Reservations count attempted sends, including provider failures and retries.
insert into public.provider_budget_policies
  (resource, enabled, daily_limit, monthly_limit, workspace_daily_limit, workspace_monthly_limit)
values
  ('x_dm_deliveries', true, 25, 250, 10, 100)
on conflict (resource) do nothing;
