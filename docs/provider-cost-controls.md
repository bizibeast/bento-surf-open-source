# Provider cost controls

## Audit: 2026-10-15 UTC

Reviewed direct paid-provider calls, scheduled jobs, queue retries, Brain indexing,
Social Insights ingestion, media import/storage, public AI tools, email delivery,
and browser rendering. Production Postgres statistics confirmed repeated ingestion
writes and background RPC traffic. These cumulative statistics are not an invoice
or an endpoint-level attribution of the earlier X bill.

### Fixed

- X Auto DM recovery polled every five minutes, rereading DMs/mentions and potentially
  five posts' likes/reposts, up to 100 accounts each. Paid background reads now default
  **off**; webhook delivery and official publishing remain. Recovery is at most daily
  if deliberately enabled. OAuth identity reads have a separate bounded allowance.
- Scheduler page loads no longer trigger paid X capability refreshes by default.
  Required publish-time X capability checks reuse verified connection metadata for seven days.
  Reconnecting refreshes capabilities immediately after a subscription change.
- Automatic X Insights refreshes retain existing metrics/content and display a paused
  note, without setting a new fetch date or claiming an empty history import succeeded.
  Bright Data mention search remains enabled. It is not a replacement for private
  X account/DM analytics. Fresh X analytics need an approved read budget or a future
  public-data ingestion adapter; the release does not pretend that adapter exists.
- Social Insights initial imports stop at five provider pages (X still has its smaller
  four-page bound). Later refreshes fetch one recent page. Older indexed posts remain,
  but their metrics do not all refresh daily. Manual refreshes have a one-hour cooldown.
- AI makes one provider attempt per call. Ordinary work prefers Workers AI; editorial
  writing retains Sonnet when configured. No automatic cross-provider spending after
  transport errors, timeouts, or malformed output. Requests have input/output ceilings,
  model allowlists, and OpenRouter routing price ceilings.
- Brain stops automatic retries after three failures. Its fingerprint includes the
  publishing profile; saving identical settings no longer forces another generation.
- All Bright Data submissions share a global/per-workspace reservation, on top of
  existing feature budgets. Errors/timeouts consume reservations conservatively.
- API Mart image submissions, reference-photo vision, SEO images, transcription,
  public screenshots and email now also reserve before contacting providers.
- Chat polling first reads a revision number; unchanged messages are not downloaded
  again. Inserts, revisions and deletes invalidate the revision. Polling is once a
  minute; Brain reads have an explicit 1,000-item bound and five-minute client freshness.
- Server analytics events/errors are capped; browser replay and heatmaps sample 10% of tabs.
  Redundant image-quota-read events and page-leave events are removed. Browser events
  still go directly to PostHog and need its provider-side billing limit.
- Expired mention caches and old preview-attempt telemetry have bounded daily cleanup.
  Existing media-import caps, R2 quota checks, source fingerprints, Discover leases,
  social job checkpoints and email idempotency are preserved.
- Missing browser-duration headers no longer become zero and refund a reservation.
- SEO's deployment guard now allows lower budgets, including zero, rather than
  requiring the maximum configured value.

## Follow-up audit: October 16

- Mention lookup uses supported free native profile APIs before paid public search. All platforms retain the three-letter minimum, three-result maximum and seven-day public search cache.
- Discover tries free YouTube/Reddit/Hacker News sources first. A shared daily brief with at least 12 relevant fresh items skips paid search; sparse briefs use at most four attempts across two rotating social groups, including widening/retries.
- Routine drafts use fresh trend evidence, cap the unreviewed backlog at nine, skip a fully occupied schedule and retain completed drafts if a later generation hits a cap/outage.
- Editorial evidence is bounded by UTF-8 bytes and reserves space for fresh sources and matching-platform voice examples. Telegram also carries trusted workspace billing scope.
- Existing owned photos are preferred. Original branded graphics/carousels provide a usable fallback without an AI image call. Opted-in generation can replace templates, never a deliberately selected creator photo.

## Initial ceilings (per deployment)

`provider_budget_policies` is private, service-role managed. Reservations use one
short database lock per resource, check all applicable caps, and increment global
and workspace counters atomically. Missing/disabled policy, DB failure or cap denial
stops the provider call. No provider call is made under the database lock.

| Resource | Global / day | Global / month | Workspace / day | Workspace / month |
| --- | ---: | ---: | ---: | ---: |
| Text AI, conservative USD reservation | $10 | $100 | $1 | $5 |
| Anonymous text tools, subset of text AI | $0.25 | $5 | n/a | n/a |
| Bright Data submissions, all features combined | 100 | 3,000 | 20 | 100 |
| X content/engagement reads | **disabled** | **disabled** | **disabled** | **disabled** |
| X identity reads | 100 | 2,000 | 3 | 10 |
| Official X post/article/repost/DM write actions | 2,500 | 30,000 | 100 | 1,000 |
| API Mart images | 100 | 1,000 | 10 | 100 |
| Reference-photo vision | 100 | 2,000 | 10 | 40 |
| SEO images | 2 | 35 | n/a | n/a |
| Transcription attempts | 20 | 300 | 5 | 30 |
| Browser time reservations | 1 hour | 30 hours | 2 minutes | 10 minutes |
| Marketing email attempts | 10,000 | 100,000 | 5,000 | 25,000 |
| Transactional email attempts | 5,000 | 50,000 | 1,000 | 5,000 |
| Image transformation attempts | 10,000 | 100,000 | 100 | 1,000 |
| Anonymous background removal, subset of transformations | 50 | 500 | n/a | n/a |
| Server analytics events/errors | 10,000 | 250,000 | 1,000 | 10,000 |

System operations without a workspace still consume global caps. Authenticated server
functions and Brain/routine/onboarding/image/proactive jobs carry trusted workspace
context. Anonymous text tools have their additional small global cap. Email does not
use the two email rows above. Every Resend send reserves from one shared budget,
`reserve_email_send` with the `email_send_budget_policy` row: by default 100 a UTC day
and 3,000 a month in total, marketing stops at 60 of the shared day total,
transactional can use up to 90, and 10 stay free for Auth SMTP. Edit that row to match
your Resend plan. Resend's quota headers are recorded so mail sent outside the worker
counts too. Transactional mail is delivered before marketing. Capped mail stays queued
with a visible error and retries at the next UTC day instead of repeatedly hitting the
provider.

AI units are microdollars using a deliberately conservative byte upper bound on input
tokens, envelope overhead, full maximum output, and $3/M input + $15/M output rate
ceilings. This is a reservation estimate, **not actual invoiced spend**. Allowlisted
Workers AI models cost below these ceilings; OpenRouter is sent `max_price` constraints.
Unknown models are refused until their pricing is reviewed. Credits/free allowances
are not assumed. Ambiguous failures are never refunded automatically.

Other resources are attempt/object/time-unit caps, **not dollar guarantees**. X counts
maximum requested objects with expansion allowance, not just HTTP requests. Browser
reservations are conservative per-attempt units. Transcription duration, scraper record
billing, platform fees, base plans, storage, CPU, traffic and changing vendor prices
must also be controlled in the vendor accounts. Never enable automatic credit recharge.
An application change cannot retroactively cap a provider's entire invoice or usage
from another application sharing its credentials.

## Economics for 1,000 users

The caps intentionally do not grow with signups. They are conservative launch limits;
some features pause when the shared pool is exhausted. The 100-image workspace maximum
is not a promise that 1,000 users can all generate 100 images within a 1,000-image pool.
Increasing capacity must be an explicit, measured decision rather than silent spending.

The current Creator Plus monthly price is $49: 1,000 paying users would generate
$49,000 gross/month before discounts, payment fees, taxes and refunds. At the $5
workspace AI reservation ceiling, a fully allocated AI pool would be $5,000/month.
At 100 images each, 100,000 images cost `100000 * actual vendor price per image`.
100 GB storage allowance each is 100 TB if fully used, not merely today's storage bill.
Model these maxima, email volume, scraping records, media operations and fixed hosting
before increasing the global pools. Do not count 1,000 free/trial users as paid revenue.
The checked-in $100 AI and 1,000-image pools are unchanged until that review.

## Operations

- Apply `20261015210000_provider_cost_guardrails.sql` before the matching Worker.
- Inspect usage without personal content:

```sql
select p.resource,p.enabled,p.daily_limit,p.monthly_limit,
       u.scope,u.period_kind,u.period_start,u.units
from public.provider_budget_policies p
left join public.provider_budget_usage u on u.resource=p.resource and u.scope='global'
order by p.resource,u.period_start desc;
```

- Lower a policy or set `enabled=false` to stop new paid attempts immediately.
- X background reads require BOTH `X_PAID_READS_ENABLED=true` and an enabled
  `x_read_units` policy with reviewed limits. Do not enable just to hide a UI error.
- Existing per-feature and media-import budgets also apply; the smallest remaining
  allowance wins. Workers in separate environments have separate database caps.
- Keep provider dashboard spending/recharge limits consistent with these ceilings.
- Local verification: `python scripts/test-provider-cost-db.py` creates a disposable
  PostgreSQL 17 container and tests policy boundaries, privileges, chat invalidation,
  cleanup, and 50 simultaneous reservations against a limit of 10.
