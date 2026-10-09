export const X_STANDARD_POST_LIMIT = 280;
export const X_LONG_POST_LIMIT = 25_000;

export type XSubscriptionType = "None" | "Basic" | "Premium" | "PremiumPlus";

export type XAccountCapabilities = {
  subscriptionType: XSubscriptionType;
  verifiedType: string | null;
  canPostLong: boolean;
  canPublishArticles: boolean;
};

export function xAccountCapabilities(
  subscriptionType: unknown,
  verifiedType: unknown,
): XAccountCapabilities {
  const tier: XSubscriptionType =
    subscriptionType === "Basic" ||
    subscriptionType === "Premium" ||
    subscriptionType === "PremiumPlus"
      ? subscriptionType
      : "None";
  const verification = typeof verifiedType === "string" ? verifiedType.toLowerCase() : null;
  const organization = verification === "business";
  return {
    subscriptionType: tier,
    verifiedType: verification,
    canPostLong: tier !== "None" || organization,
    canPublishArticles: tier === "Premium" || tier === "PremiumPlus" || organization,
  };
}

export function xCapabilitiesFromMetadata(value: unknown): XAccountCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.x_subscription_type !== "string") return null;
  return xAccountCapabilities(metadata.x_subscription_type, metadata.x_verified_type);
}

export function xCapabilitiesMetadata(capabilities: XAccountCapabilities) {
  return {
    x_subscription_type: capabilities.subscriptionType,
    x_verified_type: capabilities.verifiedType,
    x_capabilities_checked_at: new Date().toISOString(),
  };
}

export function xArticleContentState(body: string) {
  return {
    blocks: body.split(/\r?\n/).map((text) => ({ text, type: "unstyled" })),
    entities: [],
  };
}
