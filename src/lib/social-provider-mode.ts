import type { SocialProvider } from "./social-scheduler";

function normalizeMode(value: string | undefined) {
  return value?.trim().toLowerCase();
}

const PROVIDER_MODE_ENV: Partial<Record<SocialProvider, string>> = {
  linkedin: "SOCIAL_LINKEDIN_PROVIDER_MODE",
  twitter: "SOCIAL_TWITTER_PROVIDER_MODE",
  reddit: "SOCIAL_REDDIT_PROVIDER_MODE",
  tiktok: "SOCIAL_TIKTOK_PROVIDER_MODE",
};

export function socialProviderUsesMock(provider: SocialProvider) {
  if (process.env.APP_ENV !== "staging") return false;

  const overrideName = PROVIDER_MODE_ENV[provider];
  const providerMode = overrideName ? normalizeMode(process.env[overrideName]) : undefined;

  return (providerMode || normalizeMode(process.env.SOCIAL_PROVIDER_MODE)) === "mock";
}
