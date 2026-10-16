# Bento MCP tools

- `read_workspace_data`: paginated stored Brain/source documents, routines/runs, Discover/bookmarks and social account/post/history records. Read an item by ID for full text; no provider refresh.
- `get_bento_overview`: profile, plan, feature links, counts, and recent workspace state.
- `list_social_accounts`: connected publishing/Auto-DM accounts and readiness.
- `upload_media`: stream a public media URL into Bento storage, or send inline base64 up to 25 MiB over remote MCP (128 KiB through browser WebMCP). Prefer binary chunks for local files over 8 MB.
- `begin_media_upload`: check storage/plan and prepare a private two-hour binary upload. The returned HTTP instructions handle parts, completion and cancellation without exposing the account OAuth token.
- `get_content_brain`, `manage_content_brain`: inspect the Content profile, Brain documents, and index; save the profile and documents, confirm, lock, delete, or refresh indexing.
- `get_content_media`, `manage_content_media`: list/search Brain Media and its limits; register an uploaded image/video, fetch a connected post, manage folders, move items, and set or clear four hero-image slots. Use `upload_media` first and pass its `key` to `register_upload`.
- `get_content_routines`, `manage_content_routine`: inspect routine schedules and recent activity; save template/custom routines or pause/resume them.
- `get_content_agent`, `manage_content_agent`: inspect Agent conversations, send a message, edit/reject/regenerate a draft, or approve Brain/scheduling proposals.
- `get_content_discover`, `manage_content_discover`: inspect recommendations and preferences or open a creator recommendation; refresh, load more, set feedback, save/unsave items, or track/untrack creators.
- `list_social_posts`: recent drafts, scheduled posts, publishing outcomes, and stable IDs.
- `create_social_post`: create or edit a draft, schedule, or publish to connected accounts. Use `providerSettings` for YouTube title, description, privacy, and thumbnail; Instagram Trial Reels and scheduled Auto DM; TikTok privacy and interactions; and X repost timing.
- `get_scheduler_workspace`, `manage_scheduler`: inspect posting times and lifecycle state, then save posting times or reschedule, move to draft, duplicate, cancel, or delete owned posts.
- `list_auto_dm_automations`: Instagram, Facebook, or X automations and connection health.
- `save_auto_dm_automation`: create or update an automation using the platform's native validation.
- `set_auto_dm_enabled`: pause or enable one owned automation.
- `delete_auto_dm_automation`: permanently delete one owned automation.
- `list_pages`, `manage_page`, `manage_block`: inspect and change Bento pages, links, blocks, and layout.
- `get_store_workspace`, `manage_product`: inspect and manage all Store product kinds and their publication state.
- `manage_discount_code`, `manage_order_bump`, `manage_audience`: manage Store growth, lists, and email campaigns.
- `get_calendar_workspace`, `manage_calendar`: inspect and manage availability, public Calendar, reviews, and connections. Sessions use `manage_product` with `coaching_call`.
- `get_community_workspace`, `manage_community`: manage community members, posts, comments, moderation, and settings.
- `get_priority_dm_conversations`, `send_priority_dm_message`, `set_priority_dm_closed`: inspect the redacted creator inbox, reply to eligible paid conversations, and close or reopen them.
- `get_profile_workspace`, `update_profile`: inspect and change creator identity, branding, Explore visibility, plan usage, and safe payment readiness.
- `get_analytics_workspace`, `get_integration_workspace`: inspect site/social performance and connected services without returning secrets.
- `get_earn_workspace`, `manage_earn`: inspect referrals and commissions, change the referral code, or explicitly request a payout.
- `list_products`, `list_bookings`: compact product and booking lookups when the full workspace is unnecessary.

Media returned by `upload_media` can be passed directly in `create_social_post.media`. For a scheduled post, use an ISO-8601 timestamp with an offset and the creator's IANA timezone.
For a scheduled Instagram comment Auto DM, set `providerSettings.instagram.scheduledAutoDm` with `triggerType`, `keyword`, `openingMessage`, and `replyMessage`. Optional fields include public replies, email capture and prompt, follower check settings, and a final HTTPS link button. The automation activates only after Instagram confirms publication.

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

## One video, one draft, several networks

List accounts first. Replace the example UUIDs with the connected account IDs. Upload
once and replace the example media object with the actual returned `media`. This is
**one** `create_social_post` call and creates **one** draft with three targets:

```json
{
  "mode": "draft",
  "body": "A quick look at what we built this week.",
  "connectionIds": [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003"
  ],
  "connectionOverrides": {
    "00000000-0000-4000-8000-000000000001": {
      "bodyOverride": "We shipped the first version today. Here's the 30-second walkthrough."
    },
    "00000000-0000-4000-8000-000000000002": {
      "bodyOverride": "From a rough sketch to a working product. A look behind the scenes of our first launch."
    }
  },
  "providerSettings": {
    "youtube": {
      "titleOverride": "Building our first version",
      "description": "A walkthrough of what we shipped and what we learned.",
      "youtubePrivacy": "public"
    }
  },
  "media": [
    {
      "key": "REPLACE_WITH_RETURNED_KEY",
      "url": "https://app.example.com/cdn/REPLACE_WITH_RETURNED_KEY",
      "name": "launch.mp4",
      "mimeType": "video/mp4",
      "size": 22020096
    }
  ],
  "timezone": "Asia/Kolkata"
}
```

Here the first account is X, the second Instagram, and the third YouTube. They must
be real accounts returned by `list_social_accounts`. Use `connectionOverrides` for
account-specific captions, not provider names as keys. Use `providerSettings` for
platform options. For editing, add the existing post `id` and preserve intended
targets, media and options. `manage_scheduler` changes lifecycle/timing; use
`create_social_post` to edit captions. Do not create duplicate drafts to tailor text.

## Original video upload protocol

1. Read the file's size locally. Call `begin_media_upload` with `fileName`,
   `mimeType`, `kind` (`video` for video), and exact `size` in bytes. Current hosted
   paid plans allow videos up to 250 MiB per file; Free allows 10 MiB. Remaining
   storage must cover the file. Platform publishing limits are checked separately.
2. The result contains `uploadUrl`, private `headers.Authorization`, `partSize`
   (8,388,608 bytes), `partCount`, and `expiresAt` (two hours). Keep the credential
   out of chat, logs, URLs and committed files. It grants access only to this upload.
3. Using a local script or file/HTTP tool, read at most `partSize` bytes at a time.
   `PUT uploadUrl?partNumber=1` with the returned Authorization header,
   `Content-Type: application/octet-stream`, and the raw binary chunk. Continue
   with parts 2 through `partCount`. The final part can be shorter. Do not base64
   encode binary parts. Each response returns `{partNumber, etag}`.
4. After all parts succeed, `POST uploadUrl` with the same Authorization header,
   `Content-Type: application/json`, and `{"parts":[{"partNumber":1,"etag":"RETURNED_ETAG"}, ...]}`.
   This validates all parts and remaining storage, and returns `{media:{key,url,name,mimeType,size}}`.
   Only this successful completion makes the file ready for a post. Pass `media`
   directly into the single draft above.
5. Retry an interrupted part at most twice with the same part number and bytes.
   Repeating completion returns the existing file without charging storage twice.
   On cancellation/failure, `DELETE uploadUrl` with the same Authorization header
   aborts only the unfinished upload. It cannot delete a completed file. Start a
   new upload if the credential expires; do not repeatedly restart uploads.

`upload_media.sourceUrl` must be a public HTTP(S) media URL, not a local path or a
chat attachment ID. A valid Content-Length permits streaming within plan limits.
If the source has no usable size and is over 25 MiB, download it in the client and
use the binary upload protocol. Inline `base64` is only for small files (25 MiB
maximum over remote MCP; browser WebMCP accepts only 128 KiB inline). Use
`begin_media_upload` for larger local files. A client may have a smaller tool-message limit. Never reduce video
quality merely to fit the inline transport. If the client lacks file/HTTP tools,
use Bento's attachment picker, then reference the uploaded asset.


## Fetch complete stored context

Use the overview tools for initial orientation, then call `read_workspace_data`.
Responses include `items`, `hasMore`, `nextCursor` and `readFrom: "stored"`.

| Collection | Available context | Text query |
|---|---|---|
| `brain_items` | Profile/voice/strategy/story/instruction documents, confirmation state, tags and provenance | Title |
| `brain_sources` | Imported source text from connected knowledge sources, source URL and retrieval time; deleted sources excluded | Title |
| `routines` | Schedule, timezone, instructions, platforms, enabled state, next/last run | Not supported |
| `routine_runs` | Routine ID, status, scheduled time, output count and failure detail | Not supported |
| `discover_items` | All stored recommendations and older bookmarks, source dates/URLs, feedback, metrics and inspiration | Title |
| `social_accounts` | Latest cached account metrics with `fetched_at` | Not supported |
| `social_posts` | Stored captions, content type, source URL and post performance | Caption |
| `social_history` | Stored historical account metrics with `captured_at` | Not supported |

For example, find a writing-voice document:

```json
{"collection":"brain_items","query":"voice","limit":10}
```

Then call the same tool with `collection: "brain_items"` and the returned item's
`id` to read its full content. Item IDs are UUIDs except `social_history`, which
uses numeric strings. For `social_accounts`, use the returned `connection_id`.
Do not combine `id` and `cursor`.

To inspect all saved Discover items:

```json
{"collection":"discover_items","savedOnly":true,"limit":10}
```

If `hasMore` is true, pass the returned `nextCursor` as `cursor` in the next call
and retain `collection`, `savedOnly`, `query`, and `range`. A page has at most 25
records. A list's 500-character preview explicitly marks `contentTruncated`;
reading by ID returns the complete stored text. Never claim the first page is
all the user's data. Do not repeatedly refetch unchanged pages.

For social metrics, choose `range` (`today`, `3d`, `7d`, `30d`, `90d`, or `all`).
`all` means all retained data allowed by the plan, not unlimited paid history.
The response includes the effective start date, timezone and history limit.
Account snapshots are latest values; use `social_history` for time-series data.
The site aggregate remains available from `get_analytics_workspace`.

Empty results mean no matching stored records within those filters. No read tool
starts paid research or scraping. Ask for fresh collection only if the user needs
it, then use the relevant explicit refresh action with existing budgets.
