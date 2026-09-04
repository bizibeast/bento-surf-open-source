-- Keep workflow history and cleanup predictable as Auto-DM volume grows.
-- These indexes cover the remaining foreign-key lookups on durable runs.
create index if not exists instagram_dm_runs_automation_idx
  on public.instagram_dm_runs(automation_id);

create index if not exists instagram_dm_runs_audience_contact_idx
  on public.instagram_dm_runs(audience_contact_id)
  where audience_contact_id is not null;
