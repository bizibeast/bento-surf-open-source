-- Local development seed. Applied automatically by `supabase start` and
-- `supabase db reset` (see supabase config default db.seed.sql_paths). This file
-- is LOCAL ONLY: `bun run db:migrate:*` uses `supabase db push`, which pushes
-- migrations, not seeds, so nothing here ever reaches staging/production.
--
-- Migration 20261008171500_restore_profile_read_grants.sql now grants this column
-- in all environments. Keep this idempotent local grant as a seed sanity check.
--
-- plan_id is already part of the public profile column set.
grant select (plan_id) on public.profiles to authenticated;

notify pgrst, 'reload schema';
