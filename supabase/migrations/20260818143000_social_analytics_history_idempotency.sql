create unique index if not exists social_analytics_history_capture_unique
  on public.social_analytics_history(connection_id, captured_at);
