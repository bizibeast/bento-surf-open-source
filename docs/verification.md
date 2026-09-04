# Verification status

## Verified locally

- Repository boundary, TypeScript, lint, unit/integration tests, and production build.
- Representative Link, Store, newsletter, scheduler, booking, community, payment, MCP, and WebMCP test matrix.
- Cloudflare Worker dry run with the committed R2, Queue, Browser, AI, rate-limit, asset, cron, and environment bindings.

## Requires deployer infrastructure

- Fresh Supabase migration, security-advisor, and real two-tenant isolation checks require a new Supabase project or a local Supabase stack.
- Email, AI/media, social networks, payment gateways, calendars, analytics, Featurebase, Browser Rendering, and custom domains require the deployer's own sandbox or live credentials and provider approvals.
- Deployed MCP initialization and browser WebMCP discovery require the final application origin; Origin Trial tokens are domain-bound when the browser requires one.

Local mocks, successful builds, health responses, and tool listings are not recorded as live-provider proof.
