---
name: bento
description: Operate a creator's Bento workspace through MCP, including pages and links, Store products and growth tools, Calendar sessions and availability, communities, social publishing, and Auto-DMs.
---

# Bento

Use the connected Bento MCP server for Bento data and actions. Do not invent IDs: list the relevant accounts or records first.

For a social post:

1. Call `list_social_accounts` and select only accounts the user named.
2. If media is not already in Bento, call `upload_media` with one public URL or a small base64 payload.
3. Call `create_social_post` in `draft`, `schedule`, or `publish_now` mode. Publishing is an external side effect; use `publish_now` only when the user explicitly asked to publish now.

For a lead-magnet Auto-DM:

1. Call `list_social_accounts`, then `list_auto_dm_automations` for the platform.
2. Call `save_auto_dm_automation` with the connected account ID. Preserve the user's exact message, URL, trigger, and keywords.
3. Instagram and Facebook comment triggers require an opening message and confirmation button. Use email capture only when the user asked for it and provide the email prompt.

Before deleting an automation, obtain the exact ID and ask for confirmation unless the user already explicitly requested deletion. Read [references/tools.md](references/tools.md) when composing less common inputs or routing across Bento features.

For pages and links, call `list_pages` first. Use `manage_page` for secondary pages and `manage_block` for links, media, text, email capture, booking, commerce, and layout. A normal link is a `generic_link` block; put its label/title and public URL in `content`.

For Store work, call `get_store_workspace`, then use:

- `manage_product` for digital products, sessions, courses, webinars, communities, memberships, custom products, lead forms, and affiliate blocks.
- `manage_discount_code`, `manage_order_bump`, and `manage_audience` for growth operations.
- `upload_media` with kind `file` before attaching a digital-product buyer file. Never invent storage keys.

Creating a product validates its plan, payment provider, delivery assets, calendar readiness, and publication rules. Preserve prices as integer minor units (`1900` means $19.00). Sending an audience campaign emails real subscribers; do it only after an explicit user request.

For Calendar work, call `get_calendar_workspace`. Use `manage_calendar` for availability and the public calendar. Create or edit sessions through `manage_product` with kind `coaching_call`; its `settings` contain duration, timezone, availability, and meeting details.

For Community work, call `get_community_workspace` before `manage_community`. Inviting/restoring a member or publishing a creator post can send real email notifications, so require an explicit request. Confirm all delete actions unless already explicit.
