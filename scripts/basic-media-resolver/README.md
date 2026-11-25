# Private public-video compute (staging)

A small on-demand Cloudflare Container provides yt-dlp, its JavaScript challenge
runtime, browser impersonation support, and FFmpeg for YouTube/TikTok. The staging
media gateway calls it through a private service binding. Instagram, X, Pinterest
and LinkedIn continue using their existing first-party adapters. The HyperFrames
renderer and the shared Oracle/Cobalt host are unchanged.

TikTok full post URLs now queue a job without extracting a detached CDN URL.
During transfer a credential-isolated child uses one yt-dlp instance for public
metadata validation, compatible format selection and the complete file download.
Only then does FFprobe verify the input and FFmpeg export MP4 or clip audio as MP3.
The selector excludes backing-song entries and silent variants. If TikTok omits
dimensions from its H.264 download variant, it can still be downloaded and checked;
the requested resolution is a preference when that metadata is unavailable.
Short links retain metadata resolution before their native transfer session.
No paid proxy or additional downloader provider is used. Internal failure logs
contain bounded codec/dimension/hostname diagnostics, never cookies or CDN queries.

Private authenticated `GET /health` reports persisted attempt/transfer counters
without consuming capacity. The 21 November 2026 UTC commissioning window permits
50 extra daily attempts, including the subsequent MCP verification; the daily
limit returns to 50 automatically afterward.
The 250/month ceiling, transfer budgets and recorded usage are unchanged.

For a direct Cloudflare API deployment, declare `containers: [{class_name:
"BasicMedia"}]` and upload the DO binding with `name`, `type` and `class_name`.
Do not send the read-only `namespace_id` returned by GET as its upload binding.
Preserve secrets through `inherit`; never read their values. A controlled update
can use `code_update_strategy: {mode: "immediate"}` after active transfers finish.
Update the container image through an application rollout, then verify its target
instance version before testing. See [TikTok verification](../../docs/tiktok-native-staging-2026-11-21.md).

## Provision/deploy

`wrangler.basic-media.staging.jsonc` provisions one `standard-1` instance at most
(0.5 vCPU, 4 GiB RAM, 8 GB temporary disk) in North America; it sleeps after two idle minutes. There
are no public routes or workers.dev endpoints. The gateway requires the matching
`BASIC_MEDIA_RESOLVER` service binding. Set `BASIC_MEDIA_TOKEN` to the same random
secret on both staging Workers. Missing configuration fails closed.

Install the Netscape cookie export only as `YOUTUBE_COOKIE_JAR` on the private
Worker, using Cloudflare's secret interface. Never paste cookies into source,
GitHub variables, logs, build arguments, or container application configuration.
Only authorized YouTube download preparation and transfer receive the jar. Public
statistics always pass an empty cookie jar to their isolated child, including
YouTube metadata reads. A temporary mode-0600 download cookie file is removed
after extraction; environment entries are removed from the Python process
environment. TikTok receives no account cookies. Google can rotate or
reject an otherwise valid session; replacing this one Worker secret is sufficient.
The DO persists only its random internal bridge token (never the Google jar), so
job links survive Worker-isolate eviction and delayed stop callbacks. Restart the
private service after credential rotation so warm processes cannot
reuse an earlier session. `POST /restart` requires the private service credential,
destroys only this compute instance and preserves all stored usage counters.

After credentials are configured, use the dedicated **Deploy private staging media
compute** workflow, or `bun x wrangler deploy --config
wrangler.basic-media.staging.jsonc`. Existing Worker secrets are retained. Follow
`docs/environments.md` when Actions billing is unavailable; do not provision a
replacement VM or change the production origin to deploy this service.

## Boundaries and cost

Direct video/document downloads support **5 GiB** through bounded streaming. The
compute service downloads inputs into mode-0600 temporary files (5 GiB aggregate)
so FFmpeg can seek MP4 headers at the end of a file. Output is streamed, not loaded
into Worker memory. The 8 GB disk leaves room for the image and these inputs.
Source download time is at most 25 minutes, processing at most 29 minutes, and the
transfer deadline is 30 minutes. The Worker refreshes the idle timer during active
work. This is download capacity; AI transcription/reference analysis retain their
separate resource budgets. The native adapters now allow source videos up to 24
hours rather than rejecting everything over 25 minutes. Provider/platform limits
can still be stricter.

Only public YouTube metadata is accepted, including when cookies authenticate the
extractor: private, unlisted, age-restricted and live material is rejected. Source
and CDN hosts, redirects, IDs, types and output signatures are validated. FFmpeg
receives local media filenames and fixed arguments, no shell or remote playlist
URLs. Google credentials are never forwarded to CDNs, browsers or download links.
Download links sign job ID, filename and expiry for 90 seconds. HEAD requests do
not start another render/transfer. Cookie and downloaded media files never enter
Git; no media is written to shared storage.

The single Durable Object serializes execution and persists limits across restarts:
50 attempts/day and 250/month, counting failures and stream replays. Transfer blocks
are reserved before egress: 25 GiB/day and 100 GiB/month, rounded up in 64 MiB blocks.
These are staging service spending controls, not smaller per-file limits. Public
YouTube/TikTok tool requests also reserve through the existing
`provider-budget.server.ts` media-resolution pool after Turnstile verification;
MCP requests retain their verified workspace reservations. No new paid extraction
provider or always-on server is introduced.

Cloudflare's existing paid plan includes some CPU, memory, disk and egress. If those
allowances are exhausted, the conservative upper bound at 250 attempts each using
30 minutes is about $10 for compute/disk, plus up to roughly $5–6 for 100 GiB egress
at the listed regional rates, before Worker/DO operations and tax. Most reference
clips take seconds and consume much less. The shared limits still cap aggregate
work at 1,000 users; they do not promise unlimited production capacity. Increasing
those aggregate limits needs a cost review. Existing creator AI spending caps remain
in force and are not displayed in the composer.

## Verification

`python3 -m unittest discover -s scripts/basic-media-resolver -p 'test_*.py' -v`
checks public-only access, source/CDN isolation, compatible variants, oversized
inputs and TikTok clip audio rather than a full backing track. The Vitest bridge
and budget tests exercise signatures, auth, quota boundaries, rate-limit ordering,
HEAD handling, job handoff across isolate eviction/delayed stop events, credential
rotation without resetting budgets, and synthetic 3/5 GiB streams without allocating
whole files.

Always test real source URLs through staging and inspect complete output with
FFprobe. A metadata response, a cover image or a synthetic 5 GiB stream is not a
successful live platform download. Platform restrictions must be reported honestly;
never substitute an image or mark a partial transfer complete.

Latest live verification: [21 November staging report](../../docs/staging-downloaders-2026-11-21.md).
