import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const projectRef = ["abcdefghij", "klmnopqrst"].join("");
const validEnv = {
  VITE_APP_URL: "https://app.self.invalid",
  VITE_PUBLIC_URL: "https://public.self.invalid",
  VITE_SUPABASE_PROJECT_ID: projectRef,
  VITE_SUPABASE_URL: `https://${projectRef}.supabase.co`,
  VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-example-key",
};

function runVerifier(target: "staging" | "production", overrides: Record<string, string> = {}) {
  return spawnSync("bun", ["scripts/verify-deployment-env.ts", target], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...validEnv, ...overrides },
  });
}

describe("self-host deployment environment", () => {
  it("accepts core staging configuration without optional providers", () => {
    const result = runVerifier("staging");

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a Supabase project mismatch", () => {
    const result = runVerifier("staging", { VITE_SUPABASE_PROJECT_ID: "different-project" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match");
  });

  it.each([
    ["DODO_PAYMENTS_ENVIRONMENT", "live_mode"],
    ["POLAR_ENVIRONMENT", "production"],
    ["PAYPAL_ENVIRONMENT", "production"],
  ])("rejects live provider mode %s in staging", (name, value) => {
    const result = runVerifier("staging", { [name]: value });
    expect(result.status).not.toBe(0);
  });

  it("rejects example origins and mock commerce in production", () => {
    expect(runVerifier("production", { VITE_APP_URL: "https://app.example.com" }).status).not.toBe(
      0,
    );
    expect(runVerifier("production", { COMMERCE_PAYMENT_PROVIDER: "mock" }).status).not.toBe(0);
  });

  it("rejects production build origins that differ from wrangler.jsonc", () => {
    const result = runVerifier("production");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must match wrangler.jsonc");
  });
});
