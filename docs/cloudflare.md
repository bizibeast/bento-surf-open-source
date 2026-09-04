# Cloudflare deployment

`wrangler.jsonc` contains no account ID, routes, or secrets. Before deployment:

1. Replace `VITE_APP_URL` and `VITE_PUBLIC_URL` with origins you control. Put the same values and your public Supabase values in the ignored `.env` file used for the browser build.
2. Create the R2 bucket, queues, and dead-letter queues named in `wrangler.jsonc`, or rename them consistently.
3. Store values from `.env.example` with `wrangler secret put`; never add secret values to `wrangler.jsonc`.
4. Run `bun run deploy:dry-run`. It refuses example origins, missing public Supabase configuration, and unsafe provider modes before compiling. Run `bun run deploy:cloudflare` only after reviewing the target account and configuration.

Browser Rendering, Workers AI, R2, Queues, and custom domains depend on the deployer's Cloudflare plan and account permissions. Missing provider credentials leave their related Bento features unavailable rather than using Bento-owned accounts.
