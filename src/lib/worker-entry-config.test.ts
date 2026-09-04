import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Cloudflare Worker entry configuration", () => {
  it("ships a provider-owned deployment config without account or route identifiers", () => {
    const contents = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8");

    expect(contents).not.toContain('"account_id"');
    expect(contents).not.toContain('"routes"');
    expect(contents).toContain('"binding": "MEDIA_BUCKET"');
    expect(contents).toContain('"binding": "SOCIAL_PUBLISH_QUEUE"');
    expect(contents).toContain('"binding": "EMAIL_QUEUE"');
    expect(contents).toContain('"VITE_APP_URL": "https://app.example.com"');
  });

  it("keeps long media bounded while allowing the 25-minute origin limit to stream", () => {
    const resolver = readFileSync(
      resolve(process.cwd(), "src/lib/media-resolver.worker-core.ts"),
      "utf8",
    );
    expect(resolver).toContain("const MAX_TUNNEL_MILLISECONDS = 30 * 60 * 1_000;");
  });

  it("keeps the retained media resolver configuration in generated Worker types", () => {
    const contents = readFileSync(resolve(process.cwd(), "worker-configuration.d.ts"), "utf8");

    expect(contents).toContain("MEDIA_BUCKET: R2Bucket;");
  });

  it("the generated entry script refuses builds without Bento's queue handler", () => {
    const contents = readFileSync(resolve(process.cwd(), "scripts/write-worker-entry.ts"), "utf8");

    expect(contents).toContain('compiledServer.includes("async queue(batch, env")');
    expect(contents).toContain('import server from "./_ssr/index.mjs";');
    expect(contents).toContain("server.fetch(bindRuntime(request, env, context))");
    expect(contents).toContain("server.queue(batch, env, context)");
    expect(contents).toContain('compiledServer.includes("async scheduled(controller")');
    expect(contents).toContain("server.scheduled(controller, env, context)");
    expect(contents).toContain('resolve(process.cwd(), "wrangler.jsonc")');
    expect(contents).toContain("Object.assign(generatedWrangler, deploymentConfig");
  });
});
