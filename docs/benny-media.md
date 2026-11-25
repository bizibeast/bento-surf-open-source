# Benny media setup

Benny creates and revises content in chat. Memory, reusable creator skills, approval receipts, publishing and DM integrations share the same server tools as the MCP endpoints `/mcp` and `/chatgpt/mcp`. The LinkedIn workflow retains its upstream MIT attribution in `third-party/hattip-linkedin-os`.

## Services

The application runs on Cloudflare Workers with Supabase authentication, database and RLS, private R2 storage and the existing queues. Heavy work runs in separate Cloudflare Containers. HyperFrames renders validated timelines; FFmpeg handles media probing, audio mixing and frame extraction. Rendering does not run inside a normal Worker isolate.

- `wrangler.hyperframes.jsonc` deploys the renderer. Configure a strong `STUDIO_REEL_RENDERER_TOKEN` in both the renderer and app, set the app's `STUDIO_REEL_RENDERER_URL` to your renderer's HTTPS `/render` endpoint, and set a measured `STUDIO_REEL_ATTEMPT_MICROUSD` reservation. Enable only after the synthetic render and frame tests pass.
- `wrangler.basic-media.jsonc` deploys the isolated public-media resolver. Set `BASIC_MEDIA_TOKEN` in this service and the media gateway, and connect the gateway through a `BASIC_MEDIA_RESOLVER` service binding. Deploy the gateway from `src/media-resolver.worker.ts` with your own routes, upstream and shared secret. The app's `COBALT_API_URL` must point to that gateway.
- YouTube authentication is optional server-side `YOUTUBE_COOKIE_JAR` configuration. Never commit cookies. Only verified public media is accepted; private and restricted videos stay blocked. Cookies and platform IP restrictions can expire or change.

Downloads support up to 5 GiB through bounded streaming. Reference analysis is a separate compute task with shorter duration, size and decoded-frame limits. `create_video_frame_grid` supports an overview or all decoded frames, returning the image plus frame indices and timestamps.

## Providers and approval

Use your own AI provider credentials, encryption keys and model routes. Configure `EXTERNAL_TOOL_ENCRYPTION_KEY` and `BENNY_BYOK_ENCRYPTION_KEY` as independent 32-byte server keys. HeyGen BYOK uses each creator's account. Managed avatars generate only for scenes that need an avatar; narration and B-roll do not require generating a full-length avatar. Keys never belong in browser configuration.

Bento-funded managed entitlements require the hosted billing contract and are deliberately disabled for the self-hosted edition. Shared rendering, job and provider implementations are included; this repository supplies no Bento-funded credits, production billing products, credentials or complimentary grants. An operator offering their own managed service must provision and validate their commercial contracts and cost accounting.

Apply the included additive migrations before enabling reference or production jobs. Preserve RLS, service-only RPC permissions, per-tenant media paths, leases, approval checks and the database spending ceilings. Do not enable managed checkout before renderer, provider credentials, rates and billing products are verified.

## Publishing and sounds

Instagram audio availability depends on the connected account, login method and Meta's actual API support. The shared audio catalog tool checks these capabilities and supports track selection and volume controls; unsupported catalog access is reported explicitly. Existing and added audio volumes can be mixed independently by the media workflow. A preview track alone is not a finished mixed video or permission to use copyrighted music. Publishing waits for approval and confirmed platform delivery.

## Verification and costs

Run `bun run typecheck`, `bun run test:run`, `bun run build`, `bun run check:boundary` and `bun run check:history`. Database integration tests are under `supabase/tests`; offline renderer checks use `test:studio-hyperframes:offline`. Validate downloaded output with FFprobe, Pillow or a PDF parser.

Cloudflare Workers, Containers, R2 and Supabase incur your own infrastructure usage. LLM, avatar, voice and other generation services charge separately. No provider or rendering allowance is unlimited. A successful sample does not guarantee every public social post can be downloaded; failed or restricted sources must return a clear error.

## Reel audio start and preview

Uploaded tracks support a fractional start time, a listening preview at the music
volume, and a local preview of the mixed Reel before applying it. Applying reuses
the previewed MP4; changing the start or volumes invalidates that preview.
Native and ChatGPT MCP retain optional `reelAudio.trackStartSeconds` metadata for
an already mixed MP4. This field does not start a remote render.

Instagram catalog previews can be sought for listening, but Meta currently exposes
no catalog start-offset parameter or finished-mix preview. Nonzero catalog offsets
are rejected and temporary preview URLs are never used as publishing assets.
No migration, extra provider or credentials are required.

## Styles, previews and public post statistics

Memory preferences include carousel cover/inner-page style previews and a presenter
and voice gallery. Choosing a style does not authorize generation or publication.
Approved non-avatar scene holds are retained when narration fits, and large
retrievable context is bounded before recent creator edits are discarded.

`get_public_post_stats` is available through native and ChatGPT MCP. It accepts a
public Instagram, YouTube, TikTok, LinkedIn, X, Facebook, Threads or Reddit post URL.
Each returned counter includes availability, evidence, observation time and precision.
Missing values remain null. Optional connected-owner analytics requires explicit
opt-in and authorization to the selected workspace; it is separate from public data.

Public retrieval stays signed out, including the private metadata service. Downloader
cookies are never passed to post-statistics extraction. Configure your own media
gateway with `COBALT_API_URL` and `COBALT_API_KEY`; the bounded browser fallback uses
the `BROWSER` binding and existing atomic provider budgets. No hosted service access
or paid-data subscription is included. `POST_STATS_MANAGED_ENABLED=false` is the
committed default. Corporate free-tool marketing pages are outside this repository.

Some Instagram shares/reposts and LinkedIn video views/reposts are unavailable
without authenticated platform access. Business Discovery and owner analytics need
the operator's eligible platform permissions. No every-link/every-counter guarantee
is implied. Text-carousel background export remains disabled by default; provision
your queue and rendering service, then explicitly set
`BENTO_V2_STUDIO_SERVER_CAROUSELS=true` after verifying your own cost controls.
