import { normalizeEmailRecipient } from "./email-recipient";

type PublicEnvironment = Record<string, unknown>;
const DEFAULT_SOURCE_URL = "https://github.com/bizibeast/bento-surf-open-source";

function publicUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function getFeaturebasePublicConfig(env: PublicEnvironment) {
  const appId =
    typeof env.VITE_FEATUREBASE_APP_ID === "string" ? env.VITE_FEATUREBASE_APP_ID.trim() : "";
  const portalUrl = publicUrl(env.VITE_FEATUREBASE_PORTAL_URL);
  return appId && portalUrl ? { appId, portalUrl: portalUrl.replace(/\/$/, "") } : null;
}

export function getInstancePublicConfig(env: PublicEnvironment) {
  const appName = typeof env.VITE_APP_NAME === "string" ? env.VITE_APP_NAME.trim() : "";
  const supportEmail =
    typeof env.VITE_SUPPORT_EMAIL === "string"
      ? normalizeEmailRecipient(env.VITE_SUPPORT_EMAIL)
      : null;

  return {
    appName: appName || "Bento Surf",
    supportEmail,
    privacyUrl: publicUrl(env.VITE_PRIVACY_URL),
    termsUrl: publicUrl(env.VITE_TERMS_URL),
    sourceUrl: publicUrl(env.VITE_SOURCE_URL) ?? DEFAULT_SOURCE_URL,
  };
}
