ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS header_mode text NOT NULL DEFAULT 'with_photo',
  ADD COLUMN IF NOT EXISTS pattern text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS pattern_settings jsonb NOT NULL DEFAULT '{}'::jsonb;