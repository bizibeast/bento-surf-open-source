import type { CommerceProductKind, CommercePricingType } from "./commerce";
import { PAYPAL_SUPPORTED_CURRENCIES } from "@/integrations/paypal/money";

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
  subscriptionBillingIntervals?: readonly string[];
  supportedCurrencies?: readonly string[];
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
      "this application accepts only Stripe restricted keys (rk_test_ or rk_live_), encrypts them at rest, and charges your Stripe account directly. Never paste a secret key beginning with sk_.",
    creatorSetupSteps: [
      "In Stripe, open Developers → API keys → Create restricted key, choose custom permissions, then reset every permission and Connect permission to None.",
      "Allow Checkout Sessions write, Payment Intents read, Charges read, Subscriptions read, and Webhook Endpoints write.",
      "Paste the restricted key in this application. this application verifies the account and creates its signed webhook automatically.",
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
    // Digital content and channel access are eligible; manual services are not.
    // https://docs.dodopayments.com/miscellaneous/merchant-acceptance
    supportedCommerceKinds: [
      "digital_product",
      "course",
      "paid_community",
      "membership",
      "bundle",
      "newsletter",
    ],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://docs.dodopayments.com/developer-resources/integration-guide",
    setupNote:
      "This application encrypts your Dodo API key and automatically creates the signed webhook. Dodo remains the merchant of record for eligible digital content, newsletters, communities, memberships, and digital bundles. Written publications may require Dodo review; manual services are not eligible. Payouts go directly to you.",
    creatorSetupSteps: [
      "Create and verify a Dodo Payments business.",
      "Generate a dedicated API key from Developer → API keys.",
      "Paste the key into this application. this application verifies your business, creates the signed webhook, and keeps products in sync.",
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
    // Premium subscription content is eligible, but the current AUP explicitly
    // prohibits community access and human services (including hosted memberships).
    // https://polar.sh/legal/acceptable-use-policy
    supportedCommerceKinds: ["digital_product", "course", "bundle", "newsletter"],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://polar.sh/docs/integrate/oauth2/connect",
    setupNote:
      "Uses Polar OAuth and keeps eligible digital products, checkout, tax handling, and payouts in the creator's Polar organization. Polar supports premium subscription content such as newsletters and digital bundles; its policy excludes human services, community access, and physical goods.",
    creatorSetupSteps: [
      "Choose Connect Polar and sign in to Polar.",
      "Select the organization that should own products and payouts, then approve this application's requested access.",
      "Complete organization details and payouts in Polar; this application then syncs products and creates verified webhooks.",
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
    supportsSubscriptions: true,
    subscriptionBillingIntervals: ["week", "month", "year"],
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
    docsUrl: "https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/",
    setupNote:
      "This application verifies and encrypts your Razorpay keys, creates Orders or recurring Subscriptions server-side, and verifies every payment and webhook signature. Recurring plans support weekly, monthly, and yearly billing. Razorpay settles sales directly to your account.",
    creatorSetupSteps: [
      "Finish activation in Razorpay, then generate Test keys for staging or Live keys for this deployment.",
      "Paste the Key ID and Key Secret in this application. They are verified server-side and encrypted at rest.",
      "Add this application's unique webhook URL and select every event shown here, including subscription charge, pause, cancellation, and completion events.",
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
    // Creem expressly supports paid newsletters and digital communities; services
    // need separate enhanced approval and cannot be inferred from a generic kind.
    // https://www.creem.io/blog/digital-products-to-sell
    // https://docs.creem.io/merchant-of-record/account-reviews/account-reviews
    supportedCommerceKinds: [
      "digital_product",
      "course",
      "paid_community",
      "membership",
      "bundle",
      "newsletter",
    ],
    requiresProviderApproval: false,
    directConnect: true,
    docsUrl: "https://docs.creem.io/api-reference/introduction",
    setupNote:
      "This application verifies and encrypts your Creem API key. Creem remains the merchant of record for eligible digital content, newsletters, communities, memberships, and digital bundles. Services require separate enhanced approval. Creem handles tax obligations and sends payouts directly to you.",
    creatorSetupSteps: [
      "Create a Creem account and generate a Test API key for staging or a Live API key for this deployment.",
      "Paste the API key in this application. It is verified server-side and encrypted at rest.",
      "Add this application's unique URL in Creem Developers → Webhooks, select the requested events, and paste the generated webhook secret back into this application.",
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
    supportsSubscriptions: true,
    supportedCurrencies: [...PAYPAL_SUPPORTED_CURRENCIES],
    subscriptionBillingIntervals: ["day", "week", "month", "year"],
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
    docsUrl: "https://developer.paypal.com/api/rest/authentication/",
    setupNote:
      "This application encrypts the creator's PayPal REST app secret, creates Orders or recurring billing plans server-side, verifies PayPal signatures, and charges 0% platform fee. Sales settle directly to the creator's PayPal account.",
    creatorSetupSteps: [
      "Open PayPal Developer → Apps & Credentials and create a dedicated REST app.",
      "Choose Sandbox for staging.example.com or Live for this deployment, then copy the Client ID and Client Secret.",
      "Paste both in this application. this application verifies the app and registers the signed webhook automatically.",
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
  options: {
    billingInterval?: string | null;
    currency?: string;
    /**
     * Actual children loaded by the server for bundle publication/quote/checkout.
     * Omission is a capability-only query for editors and adapters; it does not
     * validate a bundle's fulfillment. Free children still need paid eligibility.
     */
    bundledProducts?: readonly { kind: CommerceProductKind }[];
  } = {},
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
  if (kind === "bundle" && options.bundledProducts !== undefined) {
    if (options.bundledProducts.length < 2 || options.bundledProducts.length > 20) {
      return {
        supported: false,
        reason: "Choose between 2 and 20 products for this bundle.",
      };
    }
    for (const child of options.bundledProducts) {
      // Nested bundles have no directly inspectable fulfillment here. Never let
      // a free child bypass the provider's restrictions on what is being sold.
      if (
        child.kind === "bundle" ||
        !creatorPaymentCompatibility(provider, child.kind, "one_time").supported
      ) {
        return {
          supported: false,
          reason: `${definition.name} cannot sell this bundle because an included product is not eligible. Choose compatible digital products or another payment gateway.`,
        };
      }
    }
  }
  if (
    options.currency &&
    definition.supportedCurrencies &&
    !definition.supportedCurrencies.includes(options.currency.toLowerCase())
  ) {
    return {
      supported: false,
      reason: `${options.currency.toUpperCase()} is not supported by ${definition.name}. Choose a supported currency for this paid offer.`,
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
  if (
    pricingType === "subscription" &&
    options.billingInterval &&
    definition.subscriptionBillingIntervals &&
    !definition.subscriptionBillingIntervals.includes(options.billingInterval)
  ) {
    return {
      supported: false,
      reason: `${definition.name} does not support this billing interval. Choose ${definition.subscriptionBillingIntervals.join(", ")} billing.`,
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
