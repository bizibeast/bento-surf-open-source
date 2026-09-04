import { afterEach, describe, expect, it } from "vitest";
import { socialProviderUsesMock } from "./social-provider-mode";

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  SOCIAL_PROVIDER_MODE: process.env.SOCIAL_PROVIDER_MODE,
  SOCIAL_LINKEDIN_PROVIDER_MODE: process.env.SOCIAL_LINKEDIN_PROVIDER_MODE,
  SOCIAL_TWITTER_PROVIDER_MODE: process.env.SOCIAL_TWITTER_PROVIDER_MODE,
  SOCIAL_REDDIT_PROVIDER_MODE: process.env.SOCIAL_REDDIT_PROVIDER_MODE,
  SOCIAL_TIKTOK_PROVIDER_MODE: process.env.SOCIAL_TIKTOK_PROVIDER_MODE,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("socialProviderUsesMock", () => {
  it("keeps every provider live outside staging", () => {
    process.env.APP_ENV = "production";
    process.env.SOCIAL_PROVIDER_MODE = "mock";

    expect(socialProviderUsesMock("linkedin")).toBe(false);
    expect(socialProviderUsesMock("instagram")).toBe(false);
  });

  it("uses the global staging provider mode by default", () => {
    process.env.APP_ENV = "staging";
    process.env.SOCIAL_PROVIDER_MODE = "mock";

    expect(socialProviderUsesMock("linkedin")).toBe(true);
    expect(socialProviderUsesMock("instagram")).toBe(true);
  });

  it("can exercise LinkedIn live while other staging providers stay mocked", () => {
    process.env.APP_ENV = "staging";
    process.env.SOCIAL_PROVIDER_MODE = "mock";
    process.env.SOCIAL_LINKEDIN_PROVIDER_MODE = "live";

    expect(socialProviderUsesMock("linkedin")).toBe(false);
    expect(socialProviderUsesMock("instagram")).toBe(true);
  });

  it("can exercise X live while other staging providers stay mocked", () => {
    process.env.APP_ENV = "staging";
    process.env.SOCIAL_PROVIDER_MODE = "mock";
    process.env.SOCIAL_TWITTER_PROVIDER_MODE = "live";

    expect(socialProviderUsesMock("twitter")).toBe(false);
    expect(socialProviderUsesMock("instagram")).toBe(true);
  });

  it("can exercise Reddit live while other staging providers stay mocked", () => {
    process.env.APP_ENV = "staging";
    process.env.SOCIAL_PROVIDER_MODE = "mock";
    process.env.SOCIAL_REDDIT_PROVIDER_MODE = "live";

    expect(socialProviderUsesMock("reddit")).toBe(false);
    expect(socialProviderUsesMock("instagram")).toBe(true);
  });

  it("can exercise TikTok live while other staging providers stay mocked", () => {
    process.env.APP_ENV = "staging";
    process.env.SOCIAL_PROVIDER_MODE = "mock";
    process.env.SOCIAL_TIKTOK_PROVIDER_MODE = "live";

    expect(socialProviderUsesMock("tiktok")).toBe(false);
    expect(socialProviderUsesMock("instagram")).toBe(true);
  });
});
