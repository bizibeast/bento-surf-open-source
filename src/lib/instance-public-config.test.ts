import { describe, expect, it } from "vitest";
import { getFeaturebasePublicConfig, getInstancePublicConfig } from "./instance-public-config";

describe("instance public configuration", () => {
  it("uses only the neutral application-name default", () => {
    expect(getInstancePublicConfig({})).toEqual({
      appName: "Bento Surf",
      supportEmail: null,
      privacyUrl: null,
      termsUrl: null,
      sourceUrl: "https://github.com/bizibeast/bento-surf-open-source",
    });
  });

  it("normalizes public values without returning unrelated environment fields", () => {
    expect(
      getInstancePublicConfig({
        VITE_APP_NAME: "  Community Hub  ",
        VITE_SUPPORT_EMAIL: " Operator@Example.com ",
        VITE_PRIVACY_URL: "https://legal.example/privacy",
        VITE_TERMS_URL: "not a URL",
        VITE_SOURCE_URL: "javascript:alert(1)",
        SUPABASE_SERVICE_ROLE_KEY: "server-secret",
      }),
    ).toEqual({
      appName: "Community Hub",
      supportEmail: "operator@example.com",
      privacyUrl: "https://legal.example/privacy",
      termsUrl: null,
      sourceUrl: "https://github.com/bizibeast/bento-surf-open-source",
    });
  });

  it("enables Featurebase only with a validated portal URL and app ID", () => {
    expect(getFeaturebasePublicConfig({})).toBeNull();
    expect(
      getFeaturebasePublicConfig({
        VITE_FEATUREBASE_APP_ID: "feedback-app",
        VITE_FEATUREBASE_PORTAL_URL: "javascript:alert(1)",
      }),
    ).toBeNull();
    expect(
      getFeaturebasePublicConfig({
        VITE_FEATUREBASE_APP_ID: " feedback-app ",
        VITE_FEATUREBASE_PORTAL_URL: "https://feedback.example/portal",
      }),
    ).toEqual({ appId: "feedback-app", portalUrl: "https://feedback.example/portal" });
  });
});
