-- PostgREST can keep serving its pre-migration schema until explicitly
-- notified. Keep this in migration history so every environment reloads after
-- the commerce tables and enum are installed.
notify pgrst, 'reload schema';
