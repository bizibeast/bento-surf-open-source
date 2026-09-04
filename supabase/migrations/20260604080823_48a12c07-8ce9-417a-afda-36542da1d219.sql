
-- Restrict sensitive Stripe columns from public reads
REVOKE SELECT (stripe_account_id, stripe_customer_id) ON public.profiles FROM anon, authenticated;
GRANT SELECT (stripe_account_id, stripe_customer_id) ON public.profiles TO service_role;

-- Avatars bucket: explicit public SELECT policy (bucket is intentionally public)
CREATE POLICY "avatars_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- block_clicks: allow anon/authenticated to record clicks
CREATE POLICY "bc_public_insert" ON public.block_clicks
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.blocks b WHERE b.id = block_id AND b.user_id = block_clicks.user_id)
  );
GRANT INSERT ON public.block_clicks TO anon, authenticated;

-- profile_views: allow anon/authenticated to record views
CREATE POLICY "pv_public_insert" ON public.profile_views
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = profile_views.user_id)
  );
GRANT INSERT ON public.profile_views TO anon, authenticated;

-- email_signups: allow anyone to subscribe to a valid profile owner
CREATE POLICY "email_signups_public_insert" ON public.email_signups
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = owner_user_id)
    AND length(email) BETWEEN 3 AND 255
    AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );
GRANT INSERT ON public.email_signups TO anon, authenticated;
