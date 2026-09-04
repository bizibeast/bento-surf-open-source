import { describe, expect, it } from "vitest";

import {
  getDeploymentEnvironment,
  getStagingIsolationErrors,
  stagingResponseHeaders,
} from "./deployment-environment.server";

const safeStagingEnv = {
  APP_ENV: "staging",
  SUPABASE_PROJECT_ID: "staging-project",
  SUPABASE_URL: "https://staging-project.supabase.co",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  CUSTOM_DOMAINS_ENABLED: "false",
  MEDIA_BUCKET: {},
  ANALYTICS_QUEUE: {},
};

describe("deployment environment isolation", () => {
  it("keeps current deployments production-compatible when APP_ENV is absent", () => {
    expect(getDeploymentEnvironment({})).toBe("production");
    expect(getStagingIsolationErrors({})).toEqual([]);
  });

  it("accepts a fully isolated staging environment", () => {
    expect(getStagingIsolationErrors(safeStagingEnv)).toEqual([]);
    expect(stagingResponseHeaders(safeStagingEnv)).toEqual({
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow, noarchive",
    });
  });

  it("does not assume a production Supabase project", () => {
    expect(getStagingIsolationErrors({ APP_ENV: "staging" })).not.toContainEqual(
      expect.stringContaining("production Supabase project"),
    );
  });

  it("rejects production data and billing credentials in staging", () => {
    const productionProjectId = "production-project";
    const errors = getStagingIsolationErrors({
      ...safeStagingEnv,
      PRODUCTION_SUPABASE_PROJECT_ID: productionProjectId,
      SUPABASE_PROJECT_ID: productionProjectId,
      SUPABASE_URL: `https://${productionProjectId}.supabase.co`,
      DODO_PAYMENTS_ENVIRONMENT: "live_mode",
      CUSTOM_DOMAINS_ENABLED: "true",
    });

    expect(errors).toContain("The staging Worker is pointing at the production Supabase project.");
    expect(errors).toContain("The staging Worker must use Dodo Payments test mode.");
    expect(errors).toContain("Custom-domain mutations must be disabled in staging.");
  });

  it("rejects mismatched staging project configuration", () => {
    expect(
      getStagingIsolationErrors({
        ...safeStagingEnv,
        SUPABASE_URL: "https://different-project.supabase.co",
      }),
    ).toContain("The staging Supabase project ID does not match its URL.");
  });

  it("rejects staging without its isolated R2 binding", () => {
    const { MEDIA_BUCKET: _, ...withoutMediaBucket } = safeStagingEnv;

    expect(getStagingIsolationErrors(withoutMediaBucket)).toContain(
      "The staging R2 bucket is not bound.",
    );
  });

  it("rejects staging without an explicit Dodo test environment", () => {
    expect(
      getStagingIsolationErrors({
        ...safeStagingEnv,
        DODO_PAYMENTS_ENVIRONMENT: undefined,
      }),
    ).toContain("The staging Worker must use Dodo Payments test mode.");
  });

  it("rejects staging without its analytics queue binding", () => {
    const { ANALYTICS_QUEUE: _, ...withoutAnalyticsQueue } = safeStagingEnv;

    expect(getStagingIsolationErrors(withoutAnalyticsQueue)).toContain(
      "The staging analytics queue is not bound.",
    );
  });
});
