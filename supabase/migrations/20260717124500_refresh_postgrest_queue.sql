-- Supabase's documented recovery for a notification listener that has kept a
-- stale schema cache even after NOTIFY.
select pg_notification_queue_usage();
notify pgrst;
