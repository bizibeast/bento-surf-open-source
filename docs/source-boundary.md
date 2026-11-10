# Source boundary

This repository contains self-hostable application surfaces: authentication, creator workspaces, public creator and product pages, commerce, scheduling, messaging, integrations, MCP, WebMCP, database migrations, and tests needed by those surfaces.

It excludes corporate marketing, comparison, alternative, feature, use-case, lead-generation, help-center, campaign, and operational surfaces. It also excludes private identities, credentials, customer data, account data, deployment material, and production evidence.

Public history starts fresh. Do not import non-public history or use it as an implementation shortcut. Changes must be reviewed as an explicit, sanitized port into this repository.

## MCP runtime sync review

The free-tool MCP runtime uses catalog metadata and AI helpers extracted into `src/lib/mcp-free-text.ts` and `src/lib/mcp-free-tools.server.ts`. It does not include the hosted marketing modules, anonymous generation endpoint, SEO copy, FAQs, or guides. Treat these two files as manual transforms during future syncs. The private sync script already detects the server file as a transform; add the text file to its transform list when planning a sync.

Exclude `scripts/fixtures/complimentary-multi-workspace.sql` as an operational fixture. The workspace grant migration and shared application types remain included.

## 5 November 2026 sync review

Exclude `src/components/LegalCompanyDetails.tsx`: it contains the hosted operator's legal name, registration numbers, and address. The public legal routes stay preserved and describe instance operators. The hosted MCP registry authentication proof and its server-header test are also held back because they bind the hosted operator's registry identity. Shared MCP safety annotations are included.

The sync review retains the earlier MCP runtime transform and operational fixture exclusion above. The reviewed sync rules and plan are recorded in `/workspace/oss-sync-1105/`.
