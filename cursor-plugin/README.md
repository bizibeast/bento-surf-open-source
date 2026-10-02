# Bento for Cursor

Remote MCP connector for [bento.surf](https://bento.surf) — the open-source creator monetisation and distribution OS, and an open-source Stan Store alternative.

Connect a Bento account to work with creator pages, Store, Calendar, social publishing, Auto-DMs, and analytics. Sign-in is OAuth with that Bento account. This plugin does not include API keys or other secrets.

## MCP endpoint

`https://mcp.bento.surf/mcp`

Streamable HTTP remote server. Cursor prompts for OAuth when the plugin connects. No API keys to paste.

## Install

Install from the Cursor Marketplace, or add the remote MCP URL manually in Cursor MCP settings:

```json
{
  "mcpServers": {
    "bento": {
      "type": "http",
      "url": "https://mcp.bento.surf/mcp"
    }
  }
}
```

## Docs

- Product: https://bento.surf
- Connect guide: https://app.bento.surf/mcp
- Privacy: https://bento.surf/privacy
- Terms: https://bento.surf/terms

## Support

support@bento.surf
