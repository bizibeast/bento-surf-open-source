# Verification status

## November 27, 2026 commerce and workspace parity

Reviewed shared source: `f6a549c94088f2d928124db1f0fd67e46c9f78e3`. The public port starts from public upstream `8a5145bc8b45c59998bdb4b1d6cf03ee558c4e69` and preserves public history, setup, neutral configuration, licensing, and operator-owned infrastructure.

Includes dedicated Courses, Community and Priority DM product creation, workspace currency preferences for new offers, provider-compatible paid newsletters and recurring offers, funded renewal periods and cancellation/refund/dispute reconciliation, required buyer questions, scoped newsletter consent, creator theme inheritance, archival visibility, and sidebar fixes. Apply all included shared migrations plus `20261127092302_public_self_hosted_edition.sql` before upgrading.

The public-only edition migration aligns database entitlements with `BENTO_EDITION=self_hosted`; it creates no hosted subscriptions, complimentary grants, or artificial profile plans. Self-hosted deployment checks no longer require the hosted contact/storage add-on catalog. Core security and production provider-mode checks remain.

Local PostgreSQL verification used an isolated clone of the final migration schema. An ordinary newly bootstrapped profile, without a paid plan or subscription/grant, receives the intended self-hosted entitlements and can accept an INR paid newsletter. The shared newsletter quota/downgrade/delivery contract then passes in transaction-scoped hosted mode; rollback restores the self-hosted edition, and the public-edition test passes again. The clone was deleted. This verifies the new public edition setting against the current schema; it does not claim that every historical migration was replayed into a brand-new operator project.

Run `scripts/test-paid-newsletter-delivery-db.sh` for the shared hosted policy contract, setting `BENTO_SUPABASE_DB_CONTAINER` and `BENTO_NEWSLETTER_TEST_DATABASE` to an isolated local instance. Its transaction restores the public edition. Run `supabase/tests/public_self_hosted_edition.sql` after public migrations to check normal self-hosted entitlements. Other new SQL harnesses also require an explicit local container/database.

Validation: frozen-lockfile installation; 5,647 passing tests across 679 files (two skipped tests/files); TypeScript with a 4 GiB heap limit; production build; production deployment guard with no hosted add-on catalog; and Cloudflare Worker packaging dry run. The dry run reports 24,832.02 KiB uncompressed / 6,088.67 KiB gzip. Public boundary and complete reachable-history scans pass, and shared-source parity reports zero missing, stale, removed, or unclassified paths. The existing reviewed historical non-secret exception remains unchanged. Focused public callback/privacy/mock fixtures (51 tests), operator-copy/staging-policy checks (14 tests), and the isolated PostgreSQL checks also pass.

The final source follow-up removes an unnecessary trigger DROP before its first creation and makes the onboarding test wait for passive-effect telemetry. Runtime application code is unchanged from the full-suite/build snapshot `884bbac80b39c38f03cbf5eb94f63b21d8c93e80`. The final delta passes 27 focused onboarding tests with CI settings and the affected SQL installation/delivery/edition-restoration checks; the earlier full application-suite and build results cover the unchanged runtime code.

No operator-owned deployment, payment, live provider call, email delivery, social publication, or hosted database migration was performed by this public sync. Private source history, credentials, customer data, and hosted release evidence were not imported. Operators must apply migrations and configure their own infrastructure and approved provider accounts.

## Earlier shared-app parity release

Shared source: `25b2bcb4f8de2cffc4a6a9d2900df55919ff91a5`. Adds polling backoff (hidden tabs stop polling, idle tabs back off, cached founder web analytics), one shared daily and monthly Resend send budget with the weekly digest split into Monday and Tuesday cohorts, and trial cancellation that ends the trial and access immediately with no charge (paid cancellations still run to the end of the paid period). Includes migration `20261023060000_resend_shared_daily_budget`; apply it before deploying this code.

Public-edition differences kept: no hosted PostHog host fallback, localhost and `example.com` defaults instead of hosted URLs and support addresses, and configured-origin checks in the post scheduler. `EMAIL_MARKETING_DAILY_CAP` and `EMAIL_TRANSACTIONAL_DAILY_CAP` are no longer read; the limits live in the `email_send_budget_policy` row.

Validation: 4,030 tests across 518 files, TypeScript, production build and the public boundary and history scans. The shared-source parity check reports zero missing, stale or removed files. Excluded by the sync rules: the hosted SEO research fallback and Bright Data backoff (`seo-search-fallback.server.ts`, `seo-bright-data.server.ts` changes), SEO MCP and editorial changes, the hosted blog copy fix script and hosted marketing, help center and `llms.txt` copy. No operator-owned instance, real provider call, paid transaction or email send was exercised. Private source history, credentials and customer data were not imported.

## Previous shared-app parity release

Shared source: `0f83d974ffd7c23992d561076d69343618c6f51c`. Adds the weekly digest send cap and daily email caps, selected-plan-only trials with cancellation at the trial end date, failed checkout return handling with a fresh session on retry, the Connect payments trial path, the onboarding Brain time budget and draft recovery, the Benny content agent with its mascot images, cost-based AI model routing and provider usage settlement, verified source links before editorial review, dash normalization in creator copy, social publish recovery, granular MCP post reads (`get_social_post`) and case-insensitive video filters. Includes migrations `20261020120000` through `20261022213629`; apply them before deploying this code.

Public-edition differences kept: no hosted PostHog host fallback (untagged events count as production only), no forced `AI_TEXT_PROVIDER`, `TIKTOK_DIRECT_POST_AUDITED` unset by default (TikTok posts stay private until the operator's audit is approved), no SEO MCP endpoint or OpenAI domain token, and the hosted Worker routes, account and deploy settings are not imported. New optional settings are documented in `.env.example`.

Validation: 4,000 tests across 516 files, TypeScript, production build and the public boundary and history scans. The shared-source parity check reports zero missing, stale or removed files. The Benny mascot images in `public/mascot/` are included. The hosted SEO citation backfill script and the founder-only AI provider diagnostics (`founder-ai-model-check.server.ts`, `founder-ai-provider.server.ts`) are excluded by the sync manifest; nothing public imports them. No operator-owned instance, real provider generation, paid transaction or social publication was exercised. Private source history, credentials and customer data were not imported.

## Earlier shared-app parity release (before `0f83d974`)

Shared source: `2772b1b739dd1ef67952f69ae5a13ffd32d41ecf`. Includes the latest Brain cleanup, personalized Topics, Stories navigation, routine content mix and draft quantity, AI-image settings access, and browser-safe server primitives. Standard X posts use the official weighted URL/Unicode/emoji count, and evidence matching accepts only equivalent spacing and quotation typography. Evidence failures identify the specific claim and field for the bounded repair pass. When visible attribution is the only remaining validation issue, the editor appends the verified original source URL only if the complete post still passes all checks. Independent semantic review and budget limits remain. The shared SERP parser also includes the current bounded malformed-response and timeout handling. Operator setup, instance URLs, legal pages and deployment configuration retain their public-edition behavior.

Validation: 3,784 tests across 498 files, TypeScript, production build, Worker packaging dry run, public boundary/history scans, and two fresh-install desktop/mobile browser tests. The setup test covers interactive key generation, private input visibility, no horizontal overflow, no browser exceptions, and no outbound mutations before configuration. The fresh-install route no longer needs a database before setup; controls wait for hydration. The public root no longer embeds a hosted Google Analytics tag.

The shared-source parity check reports zero missing, stale, removed or unclassified files; manually transformed files retain the edition differences described in `source-boundary.md`. The reviewed historical non-secret exception below is unchanged. Private source history, credentials and customer data were not imported.

These checks establish source and packaging readiness. No operator-owned self-hosted instance, real provider generation, paid transaction or social publication was exercised. Existing hosted deployment status is not evidence that an operator instance has upgraded. Apply included migrations and configure the operator's credentials before upgrading an instance.

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

## Reviewed historical non-secret fallback

The pre-existing public blob `e2273b116de932b6099f7059169ff1b17298305c` for
`src/lib/twitter-auto-dm.server.ts` contained a hosted callback-origin fallback.
The current source uses the operator's configured instance origin. An explicitly
approved historical exception covers only that origin literal in that exact
immutable blob and path. Every credential check still inspects the original
contents, all other identity findings still fail, and current-source checks have
no exception. Public history was preserved without a force-push.
