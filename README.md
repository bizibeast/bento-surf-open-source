# Bento Surf

Bento Surf is an AGPL-3.0-only, self-hosted creator application. This release is a local setup foundation: it includes application source, configuration examples, and migrations, but does not claim fresh-database, provider, MCP/WebMCP browser, or deployment proof.

## Local setup

Install Bun and the Supabase CLI, then create a Supabase project you control.

```sh
bun install
cp .env.example .env
```

Set the core Supabase and URL values in `.env`, including `SUPABASE_PROJECT_ID`, `SUPABASE_DB_URL`, and `MIGRATION_CONFIRMATION=MIGRATE:<SUPABASE_PROJECT_ID>`. Preview and apply migrations only through the guarded workflow:

```sh
bun scripts/migrate-supabase.ts --dry-run
bun scripts/migrate-supabase.ts
```

Then run:

```sh
bun run dev
bun run check
```

Optional integrations remain disabled until you add their configuration. See [configuration](docs/configuration.md); treat local checks as local evidence only.

For Cloudflare, see [the deployment guide](docs/cloudflare.md). A compatible coding agent can follow [`skills/deploy-bento/SKILL.md`](skills/deploy-bento/SKILL.md) to configure and verify an instance while keeping provider approvals and live external actions under your control.

See [verification status](docs/verification.md) for the exact boundary between local checks and provider/deployment proof.

## Source boundary

This repository includes the application and public creator/product pages. Corporate marketing pages and their related content are intentionally excluded. See [the source boundary](docs/source-boundary.md).

## License

This project is licensed under the GNU Affero General Public License v3.0 only. If you modify it and let users interact with it over a network, the AGPL requires offering those users the corresponding source. The license text is in [LICENSE](LICENSE).
