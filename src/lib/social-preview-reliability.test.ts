import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260822120000_social_preview_reliability.sql",
);

describe("social-preview reliability controls", () => {
  it("keeps attempt telemetry and provider budgets private", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("create table public.social_preview_attempts");
    expect(sql).toContain("create table public.social_preview_budgets");
    expect(sql).toContain("create or replace function public.claim_social_preview_budget");
    expect(sql).toContain("public.social_preview_budgets.used + excluded.used <= p_limit");
    expect(sql).toContain("p_units > p_limit then");
    expect(sql).toContain(
      "revoke all on public.social_preview_attempts from public, anon, authenticated",
    );
    expect(sql).toContain(
      "revoke all on sequence public.social_preview_attempts_id_seq from public, anon, authenticated",
    );
    expect(sql).toContain("grant execute on function public.claim_social_preview_budget");
  });

  it("checks the paid block entitlement before cache or provider work", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/lib/social-preview.functions.ts"),
      "utf8",
    );
    const entitlement = source.indexOf("canLoadPremiumSocialPreview(data.blockId");
    const cacheRead = source.indexOf("readPersistentPreview(key)", entitlement);
    const providerLoad = source.indexOf("loadPreview(data.platform", entitlement);
    expect(entitlement).toBeGreaterThan(-1);
    expect(cacheRead).toBeGreaterThan(entitlement);
    expect(providerLoad).toBeGreaterThan(cacheRead);
  });

  it("uses the existing Worker Browser binding without Obscura", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/lib/social-preview-reliability.server.ts"),
      "utf8",
    );
    const packageJson = await readFile(resolve(process.cwd(), "package.json"), "utf8");
    expect(source).toContain('quickAction("content"');
    expect(source).toContain('response.headers.get("x-browser-ms-used")');
    expect(packageJson.toLowerCase()).not.toContain("obscura");
  });

  it("keeps first-resolution fallbacks inside included provider allowances", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/lib/social-preview-reliability.server.ts"),
      "utf8",
    );
    expect(source).toContain("const BROWSER_DAILY_BUDGET_MS = 4 * 60 * 1_000");
    expect(source).toContain('environment === "production" ? 3_500 : 500');
  });
});
