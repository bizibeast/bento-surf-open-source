---
name: bento
description: Safe first actions in a Bento creator workspace. List accounts, pages, and drafts. Never publish, send, pay out, or delete without an explicit confirmation.
---

# Bento

Use the connected Bento MCP server. Do not invent IDs.

1. List before you change anything. Call `get_bento_overview`, `list_social_accounts`, `list_pages`, or `list_social_posts` and use only records the user named.
2. Prefer drafts. Create or update a social post as a draft until the user explicitly asks to schedule or publish that post.
3. Do not publish a post, send an audience campaign or Priority DM, invite or remove a community member, request a payout, or delete a record unless the user confirmed that exact action in this conversation.
