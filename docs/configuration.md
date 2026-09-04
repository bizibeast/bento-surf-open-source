# Configuration

Copy `.env.example` to `.env` and keep real values out of version control. Empty optional values leave related features unavailable; they do not provide simulated provider behavior. This document describes the current local foundation, not proof that a new project, provider, browser integration, or deployment has been verified.

## Core

`APP_ENV`, `VITE_APP_ENV`, `VITE_APP_NAME`, `VITE_APP_URL`, `VITE_PUBLIC_URL`, `VITE_PREVIEW_IMAGE_URL`, `VITE_SUPPORT_EMAIL`, `VITE_PRIVACY_URL`, `VITE_TERMS_URL`, `VITE_SOURCE_URL`, `FOUNDER_ADMIN_EMAILS`, `SUPABASE_PROJECT_ID`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `MIGRATION_CONFIRMATION`, `DATABASE_URL`, `PRODUCTION_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_SUPABASE_URL` define the local application and database connection. Before running `scripts/migrate-supabase.ts`, set `MIGRATION_CONFIRMATION` to `MIGRATE:<SUPABASE_PROJECT_ID>`; the script verifies that the database URL identifies that same project without logging the reference. `VITE_SOURCE_URL` overrides the source-repository link for forks.

## Security

`REFERRAL_HASH_SECRET`, `PAYMENT_CONNECTION_ENCRYPTION_KEY`, `SOCIAL_CONNECTION_ENCRYPTION_KEY`, `BOOKING_CONNECTION_ENCRYPTION_KEY`, `HEALTH_CHECK_TOKEN`, `WEBMCP_ORIGIN_TRIAL_TOKEN`, `WEBMCP_APP_ORIGIN_TRIAL_TOKEN`, and `WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN` are secrets or origin-bound values. Generate independent values for an instance. Leave `REFERRAL_COOKIE_DOMAIN` empty for host-only cookies; set it only when the configured app and public origins intentionally share a parent domain. Browser WebMCP behavior has not been proven by this foundation.

## Email

`EMAIL_DELIVERY_MODE`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM_EMAIL`, `RESEND_REPLY_TO`, `RESEND_TEST_RECIPIENT`, and `EMAIL_SIGNING_SECRET` configure mail delivery. Leave delivery disabled until the provider configuration is complete and verified by the deployer.

## AI and media

`GROQ_API_KEY`, `GROQ_TEXT_MODEL`, `CLOUDFLARE_AI_GATEWAY_ID`, `COBALT_UPSTREAM_URL`, `COBALT_UPSTREAM_API_KEY`, `COBALT_PROXY_URL`, `COBALT_YOUTUBE_SESSION_URL`, `TIKTOK_METADATA_URL`, `RESOLVER_SHARED_SECRET`, `YOUTUBE_API_KEY`, and `BRIGHT_DATA_API_KEY` enable AI or media workflows. Configure only the providers your instance is authorized to use.

## Social

`META_GRAPH_API_VERSION`, `META_INSTAGRAM_*`, `INSTAGRAM_*`, `META_FACEBOOK_*`, `FACEBOOK_*`, `SOCIAL_*`, `THREADS_*`, `TIKTOK_*`, `LINKEDIN_*`, `X_*`, `TWITTER_*`, `REDDIT_*`, and `GOOGLE_YOUTUBE_*` configure social integrations. Obtaining provider approval, OAuth consent, and live delivery evidence is outside this phase.

## Payments

`COMMERCE_PAYMENT_PROVIDER`, `DODO_*`, `STRIPE_*`, `PAYPAL_*`, `RAZORPAY_*`, and `POLAR_*` configure payment integrations and product identifiers. Use provider test settings until the instance owner has completed their own live-account review.

## Calendars

`GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` configure calendar OAuth. Calendar provider setup is not established by copying this repository.

## Analytics

`FATHOM_*`, `VITE_PUBLIC_POSTHOG_*`, `POSTHOG_*`, `VITE_FEATUREBASE_APP_ID`, `VITE_FEATUREBASE_PORTAL_URL`, `VITE_FEATUREBASE_IDENTIFY_ENABLED`, and `FEATUREBASE_JWT_SECRET` enable optional analytics or feedback integrations. Featurebase stays disabled unless both its app ID and a valid HTTP(S) portal URL are configured.

## Cloudflare

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_SAAS_TARGET`, `CUSTOM_DOMAINS_ENABLED`, and `GOOGLE_MAPS_BROWSER_KEY` configure Cloudflare-adjacent instance services. See `docs/cloudflare.md` and `skills/deploy-bento/SKILL.md`; the committed config is generic and a dry run is not live deployment proof.
