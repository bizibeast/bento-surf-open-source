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
