# Bento MCP tools

- `get_bento_overview`: profile, plan, feature links, counts, and recent workspace state.
- `list_social_accounts`: connected publishing/Auto-DM accounts and readiness.
- `upload_media`: import a public media URL or a small base64 payload into Bento storage.
- `list_social_posts`: recent drafts, scheduled posts, publishing outcomes, and stable IDs.
- `create_social_post`: draft, schedule, or publish to one or more connected accounts.
- `list_auto_dm_automations`: Instagram, Facebook, or X automations and connection health.
- `save_auto_dm_automation`: create or update an automation using the platform's native validation.
- `set_auto_dm_enabled`: pause or enable one owned automation.
- `delete_auto_dm_automation`: permanently delete one owned automation.
- `list_pages`, `manage_page`, `manage_block`: inspect and change Bento pages, links, blocks, and layout.
- `get_store_workspace`, `manage_product`: inspect and manage all Store product kinds and their publication state.
- `manage_discount_code`, `manage_order_bump`, `manage_audience`: manage Store growth, lists, and email campaigns.
- `get_calendar_workspace`, `manage_calendar`: inspect and manage availability, public Calendar, reviews, and connections. Sessions use `manage_product` with `coaching_call`.
- `get_community_workspace`, `manage_community`: manage community members, posts, comments, moderation, and settings.
- `get_profile_workspace`, `update_profile`: inspect and change creator identity, branding, Explore visibility, plan usage, and safe payment readiness.
- `get_analytics_workspace`, `get_integration_workspace`: inspect site/social performance and connected services without returning secrets.
- `get_earn_workspace`, `manage_earn`: inspect referrals and commissions, change the referral code, or explicitly request a payout.
- `list_products`, `list_bookings`: compact product and booking lookups when the full workspace is unnecessary.

Media returned by `upload_media` can be passed directly in `create_social_post.media`. For a scheduled post, use an ISO-8601 timestamp with an offset and the creator's IANA timezone.

Product fields are `kind`, `title`, `subtitle`, `description`, `cover_url`, `pricing_type`, `price_amount`, `currency`, `billing_interval`, `cta_label`, `settings`, and `inventory_limit`. Store money uses integer minor units. `settings` depends on product kind; inspect an existing same-kind product or Bento's current Store state before updating it.

Common product settings:

- `digital_product`: `files` from Bento product-file uploads (`id`, `key`, `name`, `size`, `mimeType`).
- `coaching_call`: `durationMinutes`, `timezone`, `weeklyRules`, `dateOverrides`, notice/buffer/slot fields, `meetingUrl`, and optional recording add-on.
- `course`: `lessons` with stable IDs, module/title/summary/content fields, URL, and preview state.
- `webinar`: `startsAt`, `joinUrl`, `replayUrl`, and `replayAvailable`.
- `paid_community` or `membership`: `welcomeMessage`, `rules`, `allowMemberPosts`, and `benefits`.
- `custom_product`: `fulfillmentInstructions` and `buyerQuestions`.
- `lead_form`: `fields` and `confirmationMessage`.
- `bento_affiliate`: `targetUrl`.
