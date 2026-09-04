import type { CommerceProductKind, CommercePricingType } from "./commerce";

export const CREATOR_PAYMENT_PROVIDERS = [
  "stripe",
  "dodo",
  "polar",
  "razorpay",
  "creem",
  "paypal",
] as const;

export type CreatorPaymentProvider = (typeof CREATOR_PAYMENT_PROVIDERS)[number];

export type CreatorPaymentProviderDefinition = {
  id: CreatorPaymentProvider;
  name: string;
  shortDescription: string;
  color: string;
  commissionMode: "application_fee" | "partner_fee" | "split_transfer" | "unsupported";
  connectionMode:
    "oauth" | "partner_onboarding" | "platform_onboarding" | "oauth_no_fee" | "api_key_no_fee";
  supportsOneTime: boolean;
  supportsSubscriptions: boolean;
  supportedCommerceKinds: readonly CommerceProductKind[];
  requiresProviderApproval: boolean;
  directConnect: boolean;
  docsUrl: string;
  setupNote: string;
  creatorSetupSteps: readonly string[];
};

export const CREATOR_PAYMENT_PROVIDER_DEFINITIONS: readonly CreatorPaymentProviderDefinition[] = [
  {
    id: "stripe",
    name: "Stripe",
    shortDescription: "Accept cards and wallets directly in your own Stripe account.",
    color: "#635bff",
    commissionMode: "unsupported",
    connectionMode: "api_key_no_fee",
    supportsOneTime: true,
    supportsSubscriptions: true,
    supportedCommerceKinds: [
      "digital_product",
      "coaching_call",
      "course",
      "webinar",
      "paid_community",
      "membership",
      "custom_product",
      "priority_dm",
      "bundle",
      "newsletter",
    ],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://docs.stripe.com/keys",
    setupNote:
      "The application accepts only Stripe restricted keys (rk_test_ or rk_live_), encrypts them at rest, and charges your Stripe account directly. Never paste a secret key beginning with sk_.",
    creatorSetupSteps: [
      "In Stripe, open Developers → API keys → Create restricted key, choose custom permissions, then reset every permission and Connect permission to None.",
      "Allow Checkout Sessions write, Payment Intents read, Charges read, Subscriptions read, and Webhook Endpoints write.",
      "Paste the restricted key in the application. It verifies the account and creates its signed webhook automatically.",
    ],
  },
  {
    id: "dodo",
    name: "Dodo Payments",
    shortDescription: "Dodo is merchant of record for global digital-product checkout.",
    color: "#111111",
    commissionMode: "unsupported",
    connectionMode: "api_key_no_fee",
    supportsOneTime: true,
    supportsSubscriptions: true,
    supportedCommerceKinds: ["digital_product", "course"],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://docs.dodopayments.com/developer-resources/integration-guide",
    setupNote:
      "The application encrypts your Dodo API key and automatically creates the signed webhook. Dodo remains the merchant of record for eligible digital products and sends payouts directly to you.",
    creatorSetupSteps: [
      "Create and verify a Dodo Payments business.",
      "Generate a dedicated API key from Developer → API keys.",
      "Paste the key into the application. It verifies your business, creates the signed webhook, and keeps products in sync.",
    ],
  },
  {
    id: "polar",
    name: "Polar",
    shortDescription: "Polar is merchant of record for software and digital products.",
    color: "#6b4eff",
    commissionMode: "unsupported",
    connectionMode: "oauth_no_fee",
    supportsOneTime: true,
    supportsSubscriptions: true,
    supportedCommerceKinds: ["digital_product", "course"],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://polar.sh/docs/integrate/oauth2/connect",
    setupNote:
      "Uses Polar OAuth and keeps eligible digital products, checkout, tax handling, and payouts in the creator's Polar organization. Polar does not support human services or physical goods.",
    creatorSetupSteps: [
      "Choose Connect Polar and sign in to Polar.",
      "Select the organization that should own products and payouts, then approve the application's requested access.",
      "Complete organization details and payouts in Polar; the application then syncs products and creates verified webhooks.",
    ],
  },
  {
    id: "razorpay",
    name: "Razorpay",
    shortDescription: "Accept UPI, cards, netbanking, and wallets in your own Razorpay account.",
    color: "#2b84ea",
    commissionMode: "unsupported",
    connectionMode: "api_key_no_fee",
    supportsOneTime: true,
    supportsSubscriptions: false,
    supportedCommerceKinds: [
      "digital_product",
      "coaching_call",
      "course",
      "webinar",
      "paid_community",
      "custom_product",
      "priority_dm",
      "bundle",
    ],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/",
    setupNote:
      "The application verifies and encrypts your Razorpay keys, creates Orders server-side, and verifies every checkout and webhook signature. Razorpay settles sales directly to your account.",
    creatorSetupSteps: [
      "Finish activation in Razorpay, then generate Test keys for staging or Live keys for production.",
      "Paste the Key ID and Key Secret in the application. They are verified server-side and encrypted at rest.",
      "Add the application's unique webhook URL with payment.captured, payment.failed, and refund.processed.",
    ],
  },
  {
    id: "creem",
    name: "Creem",
    shortDescription: "Creem is merchant of record for global digital-product checkout.",
    color: "#151617",
    commissionMode: "unsupported",
    connectionMode: "api_key_no_fee",
    supportsOneTime: true,
    supportsSubscriptions: true,
    supportedCommerceKinds: ["digital_product", "course"],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://docs.creem.io/api-reference/introduction",
    setupNote:
      "The application verifies and encrypts your Creem API key. Creem remains the merchant of record, handles eligible checkout and tax obligations, and sends payouts directly to you.",
    creatorSetupSteps: [
      "Create a Creem account and generate a Test API key for staging or a Live API key for production.",
      "Paste the API key in the application. It is verified server-side and encrypted at rest.",
      "Add the application's unique URL in Creem Developers → Webhooks, select the requested events, and paste the generated webhook secret back into the application.",
    ],
  },
  {
    id: "paypal",
    name: "PayPal",
    shortDescription: "Let buyers pay with PayPal, cards, Pay Later, and supported local methods.",
    color: "#0070ba",
    commissionMode: "unsupported",
    connectionMode: "api_key_no_fee",
    supportsOneTime: true,
    supportsSubscriptions: false,
    supportedCommerceKinds: [
      "digital_product",
      "coaching_call",
      "course",
      "webinar",
      "paid_community",
      "custom_product",
      "priority_dm",
      "bundle",
    ],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://developer.paypal.com/api/rest/authentication/",
    setupNote:
      "The application encrypts the creator's PayPal REST app secret, creates Orders server-side, verifies PayPal signatures, and charges 0% platform fee. Sales settle directly to the creator's PayPal account.",
    creatorSetupSteps: [
      "Open PayPal Developer → Apps & Credentials and create a dedicated REST app.",
      "Choose Sandbox for staging or Live for production, then copy the Client ID and Client Secret.",
      "Paste both in the application. It verifies the app and registers the signed webhook automatically.",
    ],
  },
] as const;

export function creatorPaymentProvider(provider: string) {
  return CREATOR_PAYMENT_PROVIDER_DEFINITIONS.find((item) => item.id === provider) ?? null;
}

export type CreatorPaymentCompatibility = {
  supported: boolean;
  reason: string | null;
};

/**
 * Canonical compatibility gate for editor publication and checkout.
 *
 * Provider adapters must not maintain their own offer allowlists. This keeps a
 * policy change from producing a product that publishes successfully but fails
 * only after a buyer attempts to pay.
 */
export function creatorPaymentCompatibility(
  provider: string,
  kind: CommerceProductKind,
  pricingType: CommercePricingType,
): CreatorPaymentCompatibility {
  if (pricingType === "free") return { supported: true, reason: null };
  const definition = creatorPaymentProvider(provider);
  if (!definition) {
    return {
      supported: false,
      reason: "Connect a supported payment gateway before publishing this paid offer.",
    };
  }
  if (!definition.supportedCommerceKinds.includes(kind)) {
    return {
      supported: false,
      reason: `${definition.name} does not support this offer type in this application. Choose a compatible gateway in Settings → Integrations.`,
    };
  }
  if (pricingType === "one_time" && !definition.supportsOneTime) {
    return {
      supported: false,
      reason: `${definition.name} does not support one-time checkout in this application.`,
    };
  }
  if (pricingType === "subscription" && !definition.supportsSubscriptions) {
    return {
      supported: false,
      reason: `${definition.name} does not support recurring checkout in this application. Choose a compatible gateway or change the price to one-time.`,
    };
  }
  return { supported: true, reason: null };
}

export function providerCanCollectBentoCommission(provider: string) {
  const definition = creatorPaymentProvider(provider);
  return Boolean(definition && definition.commissionMode !== "unsupported");
}

/**
 * These adapters create checkout-specific amounts without mutating a creator's
 * reusable remote product. Merchant-of-record catalog adapters are kept out
 * until they support an equally safe checkout-specific price contract.
 */
export function creatorPaymentSupportsCheckoutAdjustments(provider: string) {
  return (
    provider === "stripe" || provider === "paypal" || provider === "razorpay" || provider === "mock"
  );
}

export function formatFeeBps(basisPoints: number) {
  const percent = Math.max(0, basisPoints) / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

export function recommendedCreatorPaymentProvider(countryCode?: string | null) {
  return countryCode?.trim().toUpperCase() === "IN" ? ("dodo" as const) : ("polar" as const);
}
