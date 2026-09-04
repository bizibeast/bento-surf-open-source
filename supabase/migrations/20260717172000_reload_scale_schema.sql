-- PostgREST must discover the new rollup tables and RPCs before queue
-- consumers can call them. Keeping this explicit makes remote deploys
-- deterministic instead of waiting for an eventual schema-cache refresh.
notify pgrst, 'reload schema';
