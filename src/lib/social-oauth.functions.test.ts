import { afterEach, describe, expect, it } from "vitest";
import {
  assertSocialOAuthRedirectMatchesEnvironment,
  normalizedSocialConnectionScopes,
  socialProviderCredentialsConfigured,
  socialProviderReadiness,
  socialProviderRedirectUri,
  socialProviderRequestedScopes,
} from "./social-oauth.functions";

const ENV_KEYS = [
  "VITE_APP_URL",
  "META_INSTAGRAM_APP_ID",
  "META_INSTAGRAM_APP_SECRET",
  "META_FACEBOOK_APP_ID",
  "META_FACEBOOK_APP_SECRET",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "SOCIAL_CONNECTION_ENCRYPTION_KEY",
] as const;

const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnvironment(name: (typeof ENV_KEYS)[number], value: string) {
  process.env[name] = value;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnvironment[key];
    if (originalValue === undefined) delete process.env[key];
    else process.env[key] = originalValue;
  }
});

describe("social provider credential readiness", () => {
  it("reuses the published Meta app for Facebook Pages", () => {
    setEnvironment("META_INSTAGRAM_APP_ID", "meta-app");
    setEnvironment("META_INSTAGRAM_APP_SECRET", "meta-secret");

    expect(socialProviderCredentialsConfigured("facebook")).toBe(true);
  });

  it("prefers but does not require dedicated Facebook credentials", () => {
    setEnvironment("META_FACEBOOK_APP_ID", "facebook-app");
    setEnvironment("META_FACEBOOK_APP_SECRET", "facebook-secret");

    expect(socialProviderCredentialsConfigured("facebook")).toBe(true);
  });

  it("reuses the published Meta app for Threads", () => {
    setEnvironment("META_INSTAGRAM_APP_ID", "meta-app");
    setEnvironment("META_INSTAGRAM_APP_SECRET", "meta-secret");

    expect(socialProviderCredentialsConfigured("threads")).toBe(true);
  });

  it("never combines credentials from two different Meta app pairs", () => {
    setEnvironment("META_FACEBOOK_APP_ID", "partial-facebook-app");
    setEnvironment("META_INSTAGRAM_APP_SECRET", "partial-instagram-secret");

    expect(socialProviderCredentialsConfigured("facebook")).toBe(false);
  });

  it("reports Reddit readiness when its official API credentials are configured", () => {
    setEnvironment("REDDIT_CLIENT_ID", "reddit-client");
    setEnvironment("REDDIT_CLIENT_SECRET", "reddit-secret");
    setEnvironment("SOCIAL_CONNECTION_ENCRYPTION_KEY", "a".repeat(64));

    expect(socialProviderReadiness().reddit).toBe(true);
  });

  it("keeps a provider locked if either credential is missing", () => {
    setEnvironment("LINKEDIN_CLIENT_ID", "linkedin-client");

    expect(socialProviderCredentialsConfigured("linkedin")).toBe(false);
  });

  it("preserves requested permissions when a token response omits scope", () => {
    expect(normalizedSocialConnectionScopes("threads", undefined)).toEqual([
      "threads_basic",
      "threads_content_publish",
      "threads_manage_insights",
    ]);
    expect(normalizedSocialConnectionScopes("linkedin", "openid w_member_social")).toEqual([
      "openid",
      "w_member_social",
    ]);
    expect(socialProviderRequestedScopes("reddit")).toContain("submit");
  });

  it("requests the exact LinkedIn member-posting scopes", () => {
    expect(socialProviderRequestedScopes("linkedin")).toEqual([
      "openid",
      "profile",
      "w_member_social",
      "r_member_social",
      "r_member_profileAnalytics",
      "r_member_postAnalytics",
    ]);
  });

  it("requests YouTube channel analytics access", () => {
    expect(socialProviderRequestedScopes("youtube")).toContain(
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    );
  });

  it("requests only the TikTok scopes used by Direct Post and Social Insights", () => {
    expect(socialProviderRequestedScopes("tiktok")).toEqual([
      "user.info.basic",
      "user.info.stats",
      "video.list",
      "video.publish",
    ]);
  });

  it("requests Facebook Page publishing and Messenger scopes together", () => {
    expect(socialProviderRequestedScopes("facebook")).toEqual([
      "pages_show_list",
      "pages_read_user_content",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_metadata",
      "pages_manage_engagement",
      "pages_messaging",
      "read_insights",
    ]);
  });

  it("requests X posting and Direct Message scopes together", () => {
    expect(socialProviderRequestedScopes("twitter")).toEqual([
      "tweet.read",
      "tweet.write",
      "users.read",
      "offline.access",
      "media.write",
      "like.read",
      "dm.read",
      "dm.write",
    ]);
  });

  it("builds the exact production LinkedIn callback URL", () => {
    setEnvironment("VITE_APP_URL", "https://app.bento.surf/");

    expect(socialProviderRedirectUri("linkedin")).toBe(
      "https://app.bento.surf/integrations/social/linkedin/callback",
    );
  });

  it("builds the exact staging LinkedIn callback URL", () => {
    setEnvironment("VITE_APP_URL", "https://app.test.bento.surf");

    expect(socialProviderRedirectUri("linkedin")).toBe(
      "https://app.test.bento.surf/integrations/social/linkedin/callback",
    );
  });

  it("rejects an OAuth callback started in a different Bento environment", () => {
    setEnvironment("VITE_APP_URL", "https://app.test.bento.surf");

    expect(() =>
      assertSocialOAuthRedirectMatchesEnvironment(
        "linkedin",
        "https://app.bento.surf/integrations/social/linkedin/callback",
      ),
    ).toThrow("different Bento environment");
  });
});
