
-- 1) Extend block_type enum with new block kinds
ALTER TYPE public.block_type ADD VALUE IF NOT EXISTS 'contact';
ALTER TYPE public.block_type ADD VALUE IF NOT EXISTS 'audio';
ALTER TYPE public.block_type ADD VALUE IF NOT EXISTS 'file_download';
ALTER TYPE public.block_type ADD VALUE IF NOT EXISTS 'divider';
ALTER TYPE public.block_type ADD VALUE IF NOT EXISTS 'section_title';

-- 2) Add cover_url to blocks (for custom-link cover images)
ALTER TABLE public.blocks ADD COLUMN IF NOT EXISTS cover_url text;

-- 3) Add appearance + privacy + seo fields to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS noindex boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS font text NOT NULL DEFAULT 'sans';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS meta_title text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS meta_description text;

-- 4) Uploads storage bucket (public read, owner-only write under {user_id}/...)
INSERT INTO storage.buckets (id, name, public)
VALUES ('uploads', 'uploads', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "uploads_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'uploads');

CREATE POLICY "uploads_owner_insert"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'uploads'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "uploads_owner_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'uploads'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "uploads_owner_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'uploads'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
