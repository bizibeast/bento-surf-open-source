# Bento MCP for Grok Build

Connect [Bento](https://bento.surf) to Grok Build. Bento is an open-source Stan Store and Stanley.ai alternative: a creator monetisation and distribution OS for pages, Store, Calendar, social publishing, Auto-DMs, and analytics.

This plugin adds Bento's hosted MCP server. It does not install a local binary and it does not change the Bento app. On first connection, Grok opens a browser so you can sign in with your Bento account and approve access. No API key is stored in the plugin.

## Network, authentication, and secrets

The plugin configures one MCP server:

- `https://mcp.bento.surf/mcp` — hosted Bento MCP (streamable HTTP)

OAuth:

- Unauthenticated calls to that endpoint return a bearer challenge whose protected-resource metadata names Supabase Auth (`/auth/v1` on the hosted project's Supabase URL) as the authorization server.
- The browser sign-in is your Bento account at `https://app.bento.surf`.
- Requested scopes are `openid`, `email`, and `profile`.

This directory contains no API keys, client secrets, tokens, or `.env` files. It does not read local credentials. Do not paste tokens into chat. The package is markdown, JSON, and a PNG logo. It has no hooks and no executables.

Docs, not extra MCP endpoints:

- `https://app.bento.surf/mcp` — connect guide
- `https://bento.surf/privacy` — privacy policy
- `https://bento.surf/terms` — terms

## What the tools do

Tools act on the signed-in creator workspace. Publishing, sending a campaign or message, requesting a payout, and deleting a record are real side effects. Confirm those before the agent does them. The bundled `bento` skill says to list accounts and drafts first and not to publish without that confirmation.

| Area      | What you can ask for                                                            |
| --------- | ------------------------------------------------------------------------------- |
| Workspace | Overview of the profile, plan, and recent state                                 |
| Pages     | List pages, then add or edit links, media, and layout                           |
| Store     | Products, discounts, order bumps, and audiences. Prices are integer minor units |
| Calendar  | Availability and coaching sessions                                              |
| Social    | Connected accounts, media, drafts, scheduled posts, and publishing              |
| Auto-DMs  | Instagram, Facebook, and X automations                                          |
| Community | Members, posts, and moderation                                                  |
| Inbox     | Priority DM conversations and replies                                           |
| Growth    | Analytics, integrations (no secrets returned), referrals, and payouts           |

Start by listing what already exists (`list_social_accounts`, `list_pages`, `list_social_posts`, or `get_bento_overview`). Keep posts as drafts until you explicitly confirm a publish.

## Install

When Bento is in the xAI plugin marketplace, open `/plugins` in Grok Build, search for **Bento**, and install it. Start a new session. The first Bento tool call opens the browser sign-in.

To list this directory from [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace), add a remote source pinned to the full commit that contains it:

```json
{
  "name": "bento",
  "source": {
    "source": "url",
    "url": "https://github.com/bizibeast/bento-surf-open-source.git",
    "sha": "<full 40-character commit>",
    "path": "grok-plugin"
  }
}
```

`path` is required. The plugin root is `grok-plugin/`, not the repository root, so Grok Build does not pick up this app's `skills/` tree.

## License

GNU Affero General Public License v3.0 only, the same license as this repository. If you modify Bento and let users interact with it over a network, the AGPL requires offering those users the corresponding source. See [LICENSE](../LICENSE).

## Support

support@bento.surf
