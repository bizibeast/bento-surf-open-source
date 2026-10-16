-- The billing lifecycle migration revoked SELECT on profiles after the
-- column allowlist was installed. PostgreSQL removed those column grants too,
-- so authenticated sign-in immediately fails when it reads onboarded.
-- Restore an explicit owner-facing allowlist without exposing billing_lifecycle.
grant select (
  id, username, display_name, bio, avatar_url, cover_url, theme,
  accent_color, is_pro, plan_id, badge_hidden, onboarded, created_at,
  updated_at, noindex, font, meta_title, meta_description, primary_font,
  secondary_font, header_mode, pattern, pattern_settings,
  calendar_page_enabled, calendar_page_name, social_insights_enabled,
  social_insights_period_days, store_page_enabled, account_timezone,
  analytics_timezone, show_in_explore, explore_category,
  explore_review_status, booking_onboarded_at
) on public.profiles to authenticated;

notify pgrst, 'reload schema';
