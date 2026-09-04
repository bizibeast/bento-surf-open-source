---
name: deploy-bento
description: Configure, deploy, and verify a self-hosted Bento Surf checkout using infrastructure and provider credentials owned by the deployer.
---

# Deploy Bento Surf

Work from the repository root. Read `README.md`, `docs/configuration.md`, and `docs/cloudflare.md` before changing configuration.

## Boundaries

- Use only infrastructure, domains, accounts, and provider keys owned by the deployer.
- Never print, commit, or place secret values in `wrangler.jsonc`; use `.env`, `.dev.vars`, Supabase secrets, or `wrangler secret put`.
- Obtain explicit authorization immediately before creating billable resources, deploying, changing DNS, applying remote migrations, accepting provider terms, approving OAuth, or making live payment, email, message, or social-post mutations.
- Do not use a mock, health response, tool listing, or empty state as proof of a real provider outcome.

## Workflow

1. Confirm the target is local development or Cloudflare, the intended app/public origins, and which optional providers the user wants enabled. Leave all others disabled.
2. Run `bun install --frozen-lockfile`, copy `.env.example` to an ignored local environment file, and fill only the selected capabilities. Generate independent encryption/signing secrets and store them without echoing their values.
3. For Supabase, use a project selected or created by the user. Set `SUPABASE_PROJECT_ID`, `SUPABASE_DB_URL`, and `MIGRATION_CONFIRMATION=MIGRATE:<SUPABASE_PROJECT_ID>`. Run `bun scripts/migrate-supabase.ts --dry-run`; apply the migration only after the user confirms the exact project. Run Supabase security advisors when available.
4. For Cloudflare, replace the example origins in `wrangler.jsonc`. Inspect that file for required R2 and Queue resource names, create or connect those resources with authorization, set secrets through Wrangler, then run `bun run deploy:dry-run`. Run `bun run deploy:cloudflare` only after the user confirms the account and target.
5. Run `bun run check`. On a deployed instance, verify health separately from an authenticated two-tenant isolation check, representative Link and Store flows, MCP initialization/tool calls, and WebMCP tool discovery on the routes being claimed.
6. Report each capability as one of: configured only, locally verified, sandbox verified, live verified, or blocked by external approval. Include the exact commit and deployment origin. Never upgrade a claim without matching evidence.
