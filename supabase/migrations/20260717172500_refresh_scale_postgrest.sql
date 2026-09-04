-- Supabase's recovery path for a PostgREST listener that missed the payloaded
-- reload notification during a migration transaction.
select pg_notification_queue_usage();
notify pgrst;
