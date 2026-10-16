# Verification status

## October 16, 2026 creator workflow update

The shared app adds separate posting, editing and preview account controls,
per-network AI rewrite proposals, saved photos, free public-domain/CC0 stock
photos, and AI images with up to four owned reference images. Composer and Agent
images share the existing quota and provider budget. Native Agent draft previews
show the attached publishing media. Auth pages recover refresh sessions before
showing the sign-in form and transient errors do not clear sessions.

Apply `20261016101500_scheduler_image_requests.sql` before deploying this code.
Wikimedia Commons needs no key; Pexels remains an optional `PEXELS_API_KEY` secret.
The stock client identifies the configured public instance origin. Corporate
landing changes are excluded; public setup, legal pages and WebMCP remain intact.
The shared billing cancellation handler ends verified trials immediately where
an operator enables subscriptions; self-hosted entitlement behavior is unchanged.

## October 15, 2026 Content WebMCP update

This targeted update exposes the self-hosted Brain, Media, Routines, Agent, and Discover tools on `/content`, adds visible tab navigation, and bounds Content read results to omit private URLs and provider payloads. It does not change billing, migrations, provider credentials, or the self-hosted setup flow. Hosted subscription retention and founder billing metrics do not apply to this edition.

Locally verified: open-source boundary and public-history checks, TypeScript, changed-file ESLint (zero errors), all 374 test files and 2,470 tests, the production build, and a Cloudflare Worker dry run. These checks establish source and packaging readiness; they do not verify a fresh self-hosted database, configured provider, or deployed operator instance. The upstream source snapshot below remains the earlier full-parity review; this is a scoped WebMCP port.

## October 4, 2026 local parity update

The source snapshot in `upstream-source.json` includes reviewed working-tree changes. Content Agent, Brain, discovery, media indexing, custom routines and document editing; workspace ownership/isolation and signed workspace selection; Notion, Granola, GitHub, Slack and Telegram integrations; daily Social Insights refresh; Instagram Trial Reels; integration reconnect/storage fixes; and authenticated appearance changes are included.

Locally verified:

- Source parity: zero missing, stale, removed or unclassified files under the sync manifest, including the explicit reviewed source files recorded in `upstream-source.json`.
- Public working-tree boundary and complete reachable public Git-history scans pass. Private source history is not imported.
- TypeScript passes; ESLint passes with nine Fast Refresh warnings.
- All 367 test files pass: 2,399 tests. The final Worker packaging/configuration, runtime hydration and Telegram disclosure checks also pass independently (45 tests).
- Production build passes. Cloudflare Worker dry run includes Telegram queues, image normalization, queue consumers and scheduled processing. No deployment occurred.
- Source sync/parity regressions pass (20 tests); diff whitespace checks pass.

Public-only instance configuration, legal pages, provider defaults, license and packaging are preserved. OAuth callback defaults use the configured instance origin. OpenRouter attribution uses the configured instance name/origin. Workspace signing and optional integration secrets must be provisioned by the operator; `.env.example` contains empty slots.

## Requires deployer-owned infrastructure

Fresh Supabase migrations, two-tenant runtime isolation, provider delivery and OAuth approvals still require a fresh database and the deployer's credentials. The local suite exercises migration contracts, workspace isolation and mocked provider behavior; it does not prove a deployed database or real integrations.

MCP initialization and browser WebMCP discovery require the final application origin; Origin Trial tokens are domain-bound. Successful builds, dry runs and unit tests are not recorded as live-provider verification. No GitHub push, database migration or public deployment is included in this local update.
