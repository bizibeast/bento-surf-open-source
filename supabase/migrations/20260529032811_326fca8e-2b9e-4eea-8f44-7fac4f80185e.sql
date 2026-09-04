
-- Replace the broad public SELECT with an owner-only listing policy.
-- Public profile pages access files via direct public URLs (the bucket is public),
-- so files still display; only listing via the API is restricted.
DROP POLICY IF EXISTS "uploads_public_read" ON storage.objects;

CREATE POLICY "uploads_owner_list"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'uploads'
  AND auth.uid()::text = (storage.foldername(name))[1]
);
