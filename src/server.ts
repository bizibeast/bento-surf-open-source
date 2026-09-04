import "./lib/error-capture";
import llmsTxt from "../public/llms.txt?raw";
import robotsTxt from "../public/robots.txt?raw";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { isDodoAddonConfigurationReady } from "./lib/billing-addons";
import {
  handleDodoWebhook,
  processVerifiedDodoEvent,
  type DodoQueueMessage,
} from "./integrations/dodo/webhook.server";
import { captureServerEvent, captureServerException } from "./lib/posthog.server";
import {
  handleInstagramDataDeletionStatusRequest,
  handleInstagramDataRequest,
} from "./integrations/meta/data-requests.server";
import { handleR2StorageRequest } from "./lib/r2-storage.server";
import { handleBentoMcpRequest } from "./lib/mcp.server";
import { OPEN_GRAPH_IMAGE_PATH, handleOpenGraphImageRequest } from "./lib/open-graph-image.server";
import { GOOGLE_MAP_EMBED_PATH, handleGoogleMapEmbedRequest } from "./lib/google-map.server";
import {
  COMMERCE_DOWNLOAD_PATH,
  handleCommerceDownloadRequest,
} from "./lib/commerce-download.server";
import {
  getDeploymentEnvironment,
  getStagingIsolationErrors,
  stagingResponseHeaders,
} from "./lib/deployment-environment.server";
import {
  handleAnalyticsEventRequest,
  insertAnalyticsEventBatch,
} from "./lib/analytics-ingest.server";
import type { AnalyticsEvent } from "./lib/analytics-event";
import { readPublicPageCache, storePublicPageCache } from "./lib/public-page-cache.server";
import { handleReferralRedirect } from "./lib/referral.server";
import {
  enqueueDueReferralReach,
  processReferralQueueMessage,
  reconcileReferralLedger,
  type ReferralQueueMessage,
} from "./lib/referral-worker.server";
import { handlePolarWebhook } from "./integrations/polar/webhook.server";
import { handleDodoCreatorWebhook } from "./integrations/dodo/creator-webhook.server";
import {
  handleDirectStripeWebhook,
  handleStripeWebhook,
} from "./integrations/stripe/webhook.server";
import {
  handleDirectPayPalWebhook,
  handlePayPalWebhook,
} from "./integrations/paypal/webhook.server";
import { handleRazorpayWebhook } from "./integrations/razorpay/webhook.server";
import { handleCreemWebhook } from "./integrations/creem/webhook.server";
import {
  enqueueDueAudienceCampaigns,
  enqueueLifecycleEmails,
  getEmailDeliveryReadiness,
  handleEmailUnsubscribeRequest,
  processAudienceCampaignQueueMessage,
  processEmailOutbox,
  reconcilePriorityDmNotifications,
  type EmailQueueMessage,
} from "./lib/email.server";
import { handleResendWebhook } from "./lib/resend-webhook.server";
import {
  auditSocialConnections,
  enqueueDueSocialPosts,
  processSocialPublishMessage,
  type SocialPublishMessage,
} from "./lib/social-publisher.server";
import {
  failSocialInsightsBackfillMessage,
  normalizeSocialInsightsBackfillMessage,
  processSocialInsightsBackfillMessage,
  releaseSocialInsightsBackfillMessage,
  requeueStaleSocialInsightsBackfills,
  socialInsightsDeliveryDisposition,
  type SocialInsightsBackfillMessage,
} from "./lib/social-analytics.functions";
import {
  auditInstagramConnections,
  enqueueInstagramCommentReconciliations,
  getInstagramDmRetryDelaySeconds,
  handleInstagramWebhook,
  handleInstagramWebhookVerification,
  processInstagramDmQueueMessage,
  type InstagramDmQueueMessage,
} from "./lib/instagram-auto-dm.server";
import {
  enqueueTwitterDmReconciliations,
  getTwitterDmRetryDelaySeconds,
  handleTwitterWebhook,
  handleTwitterWebhookCrc,
  processTwitterDmQueueMessage,
  type TwitterDmQueueMessage,
} from "./lib/twitter-auto-dm.server";
import {
  auditFacebookConnections,
  getFacebookDmRetryDelaySeconds,
  handleFacebookWebhook,
  handleFacebookWebhookVerification,
  processFacebookDmQueueMessage,
  type FacebookDmQueueMessage,
} from "./lib/facebook-auto-dm.server";
import { processBookingFollowups } from "./lib/booking-followups.server";
import { routeCanonicalHostname } from "./lib/hostname-routing.server";
import { configuredPublicOrigin } from "./lib/application-urls";
import { redactSensitivePathname } from "./lib/safe-url";
import { expireStaleCommerceCheckouts } from "./lib/checkout-recovery.server";
import { reconcileCommerceFulfillment } from "./lib/commerce-fulfillment.server";
import { expireCommerceSubscriptionAccess } from "./lib/commerce-subscription-lifecycle.server";
import { isServerSecretEncryptionKeyValid } from "./lib/secret-crypto.server";
import {
  loadSitemapManifest,
  loadSitemapShard,
  parseSitemapShardPath,
  renderSitemapIndex,
  renderSitemapUrlSet,
} from "./lib/seo-sitemap.server";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

type WorkerContext = { waitUntil?: (promise: Promise<unknown>) => void };
type RuntimeEnv = Env & {
  TURNSTILE_VERIFIER_URL?: string;
  ANALYTICS_QUEUE?: Queue<AnalyticsEvent>;
  ANALYTICS_QUEUE_1?: Queue<AnalyticsEvent>;
  ANALYTICS_QUEUE_2?: Queue<AnalyticsEvent>;
  ANALYTICS_QUEUE_3?: Queue<AnalyticsEvent>;
  BILLING_QUEUE?: Queue<DodoQueueMessage>;
  EMAIL_QUEUE?: Queue<EmailQueueMessage>;
  SOCIAL_PUBLISH_QUEUE?: Queue<SocialPublishMessage>;
  SOCIAL_INSIGHTS_QUEUE?: Queue<SocialInsightsBackfillMessage>;
  REFERRAL_QUEUE?: Queue<ReferralQueueMessage>;
  SOCIAL_PUBLISH_QUEUE_META?: Queue<SocialPublishMessage>;
  SOCIAL_PUBLISH_QUEUE_LINKEDIN?: Queue<SocialPublishMessage>;
  SOCIAL_PUBLISH_QUEUE_X?: Queue<SocialPublishMessage>;
  SOCIAL_PUBLISH_QUEUE_TIKTOK?: Queue<SocialPublishMessage>;
  SOCIAL_PUBLISH_QUEUE_YOUTUBE?: Queue<SocialPublishMessage>;
  SOCIAL_PUBLISH_QUEUE_REDDIT?: Queue<SocialPublishMessage>;
  INSTAGRAM_DM_QUEUE?: Queue<InstagramDmQueueMessage>;
  TWITTER_DM_QUEUE?: Queue<TwitterDmQueueMessage>;
  FACEBOOK_DM_QUEUE?: Queue<FacebookDmQueueMessage>;
};
type CloudflareRequest = Request & {
  runtime?: {
    cloudflare?: {
      env?: RuntimeEnv;
      context?: ExecutionContext;
    };
  };
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

const RUNTIME_STRING_BINDING_PREFIXES = [
  "SUPABASE_",
  "VITE_",
  "DODO_",
  "POLAR_",
  "STRIPE_",
  "PAYPAL_",
  "RAZORPAY_",
  "PAYMENT_",
  "COMMERCE_",
  "POSTHOG_",
  "META_",
  "CLOUDFLARE_",
  "GOOGLE_",
  "GROQ_",
  "COBALT_",
  "FATHOM_",
  "BOOKING_",
  "YOUTUBE_",
  "BRIGHT_DATA_",
  "RESEND_",
  "EMAIL_",
  "FEATUREBASE_",
  "SOCIAL_",
  "REFERRAL_",
  "THREADS_",
  "TIKTOK_",
  "LINKEDIN_",
  "X_",
] as const;
const RUNTIME_STRING_BINDING_NAMES = new Set([
  "APP_ENV",
  "CUSTOM_DOMAINS_ENABLED",
  "FOUNDER_ADMIN_EMAILS",
  "INSTAGRAM_ACCESS_TOKEN",
  "INSTAGRAM_BUSINESS_ACCOUNT_ID",
  "INSTAGRAM_WEBHOOK_VERIFY_TOKEN",
  "X_BEARER_TOKEN",
]);

// Cloudflare bindings arrive on the fetch handler's `env` argument. Nitro's
// server functions read configuration from process.env, so hydrate those
// bindings before any SSR or server-function module executes. Webhooks already
// did this locally; the founder analytics path needs the same request-time
// guarantee for POSTHOG_QUERY_API_KEY and the rest of the dashboard secrets.
function hydrateRuntimeEnv(env: unknown) {
  if (!env || typeof env !== "object") return;
  globalThis.__env__ = env as Env;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    const allowed =
      RUNTIME_STRING_BINDING_NAMES.has(key) ||
      RUNTIME_STRING_BINDING_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (allowed && typeof value === "string") process.env[key] = value;
  }
}

function isPrivateApplicationPath(pathname: string) {
  return [
    "/link",
    "/settings",
    "/admin",
    "/store",
    "/calendar",
    "/community",
    "/analytics",
    "/onboarding",
    "/login",
    "/signup",
    "/reset-password",
    "/access",
    "/library",
    "/review",
    "/payments",
    "/integrations",
    "/post-scheduler",
    "/earn",
    "/auto-dms",
    "/home",
    "/mcp",
    "/social-insights",
    "/dashboard",
    "/products",
    "/bookings",
    "/scheduler",
    "/automations",
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function appendCspDirective(policy: string, directive: string) {
  const name = directive.split(/\s+/, 1)[0];
  if (policy.split(";").some((part) => part.trimStart().toLowerCase().startsWith(`${name} `))) {
    return policy;
  }
  return policy ? `${policy.replace(/;?\s*$/, ";")} ${directive}` : directive;
}

function explicitHttpOrigin(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function webMcpOriginTrialToken(env: unknown, requestOrigin: string) {
  const values = env as Record<string, unknown> | undefined;
  const appOrigin = explicitHttpOrigin(values?.VITE_APP_URL);
  const publicOrigin = explicitHttpOrigin(values?.VITE_PUBLIC_URL);
  if (requestOrigin !== appOrigin && requestOrigin !== publicOrigin) return null;

  const token = (name: string) => {
    const value = values?.[name];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  if (appOrigin === publicOrigin) {
    return (
      token("WEBMCP_APP_ORIGIN_TRIAL_TOKEN") ??
      token("WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN") ??
      token("WEBMCP_ORIGIN_TRIAL_TOKEN")
    );
  }
  return requestOrigin === appOrigin
    ? token("WEBMCP_APP_ORIGIN_TRIAL_TOKEN")
    : token("WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN");
}

export function withDeploymentHeaders(response: Response, env: unknown, request?: Request) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(
    stagingResponseHeaders(env as Record<string, unknown> | undefined),
  )) {
    headers.set(name, value);
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("cross-origin-opener-policy", "same-origin-allow-popups");

  let contentSecurityPolicy = headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://maps.googleapis.com https://maps.gstatic.com https://static.cloudflareinsights.com https://us-assets.i.posthog.com https://challenges.cloudflare.com https://do.featurebase.app",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://us.i.posthog.com https://cloudflareinsights.com https://*.featurebase.app wss://ws.featurebase.app https://api.razorpay.com https://maps.googleapis.com https://maps.gstatic.com",
    "media-src 'self' blob: https:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    contentSecurityPolicy = appendCspDirective(contentSecurityPolicy, directive);
  }
  if (request) {
    const url = new URL(request.url);
    if (
      url.pathname !== "/api" &&
      !url.pathname.startsWith("/api/") &&
      headers.get("content-type")?.startsWith("text/html")
    ) {
      const originTrialToken = webMcpOriginTrialToken(env, url.origin);
      if (originTrialToken) headers.set("origin-trial", originTrialToken);
    }
    if (url.protocol === "https:") {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    const creatorProductPath = /^\/@[^/]+\/products\/[^/]+(?:\/success)?\/?$/.test(url.pathname);
    const privatePath =
      isPrivateApplicationPath(url.pathname) ||
      /^\/p\/[^/]+\/success\/?$/.test(url.pathname) ||
      /^\/@[^/]+\/products\/[^/]+\/success\/?$/.test(url.pathname);
    if (privatePath) headers.set("x-robots-tag", "noindex, nofollow");
    const denyFraming =
      privatePath || creatorProductPath || url.pathname === "/p" || url.pathname.startsWith("/p/");
    if (denyFraming) {
      contentSecurityPolicy = appendCspDirective(contentSecurityPolicy, "frame-ancestors 'none'");
      headers.set("x-frame-options", "DENY");
    }
    if (privatePath) {
      headers.set("cache-control", "private, no-store");
    }
    if (request.headers.has("authorization")) headers.set("cache-control", "private, no-store");
  }
  headers.set("content-security-policy", contentSecurityPolicy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function deploymentHealth(env: unknown) {
  const runtimeEnv = env as Record<string, unknown> | undefined;
  const environment = getDeploymentEnvironment(runtimeEnv);
  const isolationErrors = getStagingIsolationErrors(runtimeEnv);
  const analyticsQueueShards = [
    runtimeEnv?.ANALYTICS_QUEUE,
    runtimeEnv?.ANALYTICS_QUEUE_1,
    runtimeEnv?.ANALYTICS_QUEUE_2,
    runtimeEnv?.ANALYTICS_QUEUE_3,
  ].filter(Boolean).length;
  const polarOAuthReady = Boolean(
    runtimeEnv?.POLAR_CLIENT_ID &&
    runtimeEnv?.POLAR_CLIENT_SECRET &&
    runtimeEnv?.PAYMENT_CONNECTION_ENCRYPTION_KEY,
  );
  const paymentCredentialStorageReady = Boolean(runtimeEnv?.PAYMENT_CONNECTION_ENCRYPTION_KEY);
  const creatorPayments = {
    stripe: paymentCredentialStorageReady,
    dodo: paymentCredentialStorageReady,
    polar: polarOAuthReady,
    razorpay: paymentCredentialStorageReady,
    creem: paymentCredentialStorageReady,
    paypal: paymentCredentialStorageReady,
  };
  const supabaseReady = Boolean(
    runtimeEnv?.SUPABASE_URL &&
    runtimeEnv?.SUPABASE_PUBLISHABLE_KEY &&
    runtimeEnv?.SUPABASE_SERVICE_ROLE_KEY,
  );
  const posthogReady = Boolean(
    runtimeEnv?.POSTHOG_HOST &&
    runtimeEnv?.POSTHOG_PROJECT_KEY &&
    runtimeEnv?.POSTHOG_QUERY_API_KEY,
  );
  const liveSocialPreviews = {
    instagram: Boolean(runtimeEnv?.BRIGHT_DATA_API_KEY && runtimeEnv?.MEDIA_BUCKET),
    twitter: Boolean(runtimeEnv?.BROWSER),
    linkedin: Boolean(runtimeEnv?.BRIGHT_DATA_API_KEY),
    youtube: Boolean(runtimeEnv?.YOUTUBE_API_KEY),
    github: true,
    reddit: true,
  };
  const googleBookingOAuthReady = Boolean(
    (runtimeEnv?.GOOGLE_CALENDAR_CLIENT_ID || runtimeEnv?.GOOGLE_YOUTUBE_CLIENT_ID) &&
    (runtimeEnv?.GOOGLE_CALENDAR_CLIENT_SECRET || runtimeEnv?.GOOGLE_YOUTUBE_CLIENT_SECRET) &&
    runtimeEnv?.BOOKING_CONNECTION_ENCRYPTION_KEY,
  );
  const fathomBookingOAuthReady = Boolean(
    runtimeEnv?.FATHOM_CLIENT_ID &&
    runtimeEnv?.FATHOM_CLIENT_SECRET &&
    runtimeEnv?.BOOKING_CONNECTION_ENCRYPTION_KEY,
  );
  const emailDelivery = getEmailDeliveryReadiness();
  const socialEncryptionReady = isServerSecretEncryptionKeyValid(
    runtimeEnv?.SOCIAL_CONNECTION_ENCRYPTION_KEY,
  );
  const instagramAutoDmReady = Boolean(
    runtimeEnv?.INSTAGRAM_DM_QUEUE &&
    runtimeEnv?.META_INSTAGRAM_APP_ID &&
    runtimeEnv?.META_INSTAGRAM_APP_SECRET &&
    runtimeEnv?.INSTAGRAM_WEBHOOK_VERIFY_TOKEN &&
    socialEncryptionReady,
  );
  const twitterAutoDmReady = Boolean(
    runtimeEnv?.TWITTER_DM_QUEUE &&
    runtimeEnv?.X_CLIENT_ID &&
    runtimeEnv?.X_CLIENT_SECRET &&
    socialEncryptionReady,
  );
  const facebookAutoDmReady = Boolean(
    runtimeEnv?.FACEBOOK_DM_QUEUE &&
    ((runtimeEnv?.META_FACEBOOK_APP_ID && runtimeEnv?.META_FACEBOOK_APP_SECRET) ||
      (runtimeEnv?.META_INSTAGRAM_APP_ID && runtimeEnv?.META_INSTAGRAM_APP_SECRET)) &&
    (runtimeEnv?.FACEBOOK_WEBHOOK_VERIFY_TOKEN || runtimeEnv?.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) &&
    socialEncryptionReady,
  );
  const dodoBillingReady = Boolean(
    runtimeEnv?.DODO_PAYMENTS_API_KEY &&
    runtimeEnv?.DODO_PAYMENTS_WEBHOOK_KEY &&
    runtimeEnv?.DODO_STORE_MONTHLY_PRODUCT_ID &&
    runtimeEnv?.DODO_STORE_YEARLY_PRODUCT_ID &&
    runtimeEnv?.DODO_CREATOR_MONTHLY_PRODUCT_ID &&
    runtimeEnv?.DODO_CREATOR_YEARLY_PRODUCT_ID &&
    isDodoAddonConfigurationReady(
      (runtimeEnv ?? {}) as unknown as Record<string, string | undefined>,
    ),
  );
  const googleMapsReady = Boolean(runtimeEnv?.GOOGLE_MAPS_BROWSER_KEY);
  const featurebaseReady = Boolean(
    runtimeEnv?.VITE_FEATUREBASE_APP_ID && runtimeEnv?.FEATUREBASE_JWT_SECRET,
  );
  const socialOAuth = {
    instagram: Boolean(
      socialEncryptionReady &&
      runtimeEnv?.META_INSTAGRAM_APP_ID &&
      runtimeEnv?.META_INSTAGRAM_APP_SECRET,
    ),
    facebook: Boolean(
      socialEncryptionReady &&
      ((runtimeEnv?.META_FACEBOOK_APP_ID && runtimeEnv?.META_FACEBOOK_APP_SECRET) ||
        (runtimeEnv?.META_INSTAGRAM_APP_ID && runtimeEnv?.META_INSTAGRAM_APP_SECRET)),
    ),
    threads: Boolean(
      socialEncryptionReady &&
      ((runtimeEnv?.THREADS_APP_ID && runtimeEnv?.THREADS_APP_SECRET) ||
        (runtimeEnv?.META_INSTAGRAM_APP_ID && runtimeEnv?.META_INSTAGRAM_APP_SECRET)),
    ),
    tiktok: Boolean(
      socialEncryptionReady && runtimeEnv?.TIKTOK_CLIENT_KEY && runtimeEnv?.TIKTOK_CLIENT_SECRET,
    ),
    linkedin: Boolean(
      socialEncryptionReady && runtimeEnv?.LINKEDIN_CLIENT_ID && runtimeEnv?.LINKEDIN_CLIENT_SECRET,
    ),
    twitter: Boolean(
      socialEncryptionReady && runtimeEnv?.X_CLIENT_ID && runtimeEnv?.X_CLIENT_SECRET,
    ),
    youtube: Boolean(
      socialEncryptionReady &&
      runtimeEnv?.GOOGLE_YOUTUBE_CLIENT_ID &&
      runtimeEnv?.GOOGLE_YOUTUBE_CLIENT_SECRET,
    ),
    reddit: Boolean(
      socialEncryptionReady && runtimeEnv?.REDDIT_CLIENT_ID && runtimeEnv?.REDDIT_CLIENT_SECRET,
    ),
  };
  const healthErrors = [
    ...isolationErrors,
    ...(!runtimeEnv?.MEDIA_BUCKET ? ["R2 media storage is not configured."] : []),
    ...(analyticsQueueShards !== 4 ? ["Analytics queue shards are not configured."] : []),
    ...(!runtimeEnv?.ANALYTICS_RATE_LIMITER ? ["Analytics rate limiting is not configured."] : []),
    ...(!runtimeEnv?.UPLOAD_RATE_LIMITER ? ["Upload rate limiting is not configured."] : []),
    ...(!runtimeEnv?.PUBLIC_API_RATE_LIMITER
      ? ["Public API rate limiting is not configured."]
      : []),
    ...(!runtimeEnv?.EXPENSIVE_API_RATE_LIMITER
      ? ["Expensive API rate limiting is not configured."]
      : []),
    ...(!runtimeEnv?.AUTH_EMAIL_RATE_LIMITER
      ? ["Authentication email rate limiting is not configured."]
      : []),
    ...(!runtimeEnv?.CHECKOUT_RATE_LIMITER ? ["Checkout rate limiting is not configured."] : []),
    ...(typeof runtimeEnv?.HEALTH_CHECK_TOKEN !== "string" ||
    runtimeEnv.HEALTH_CHECK_TOKEN.length < 32
      ? ["Protected health access is not configured."]
      : []),
    ...(!runtimeEnv?.BILLING_QUEUE ? ["Billing queue is not configured."] : []),
    ...(!runtimeEnv?.EMAIL_QUEUE ? ["Email delivery queue is not configured."] : []),
    ...(!runtimeEnv?.REFERRAL_QUEUE ? ["Referral verification queue is not configured."] : []),
    ...(!runtimeEnv?.SOCIAL_PUBLISH_QUEUE ? ["Social publishing queue is not configured."] : []),
    ...(!supabaseReady ? ["Supabase is not configured."] : []),
    ...(!paymentCredentialStorageReady
      ? ["Creator payment credential storage is not configured."]
      : []),
    ...(!dodoBillingReady ? ["Dodo plan billing is not configured."] : []),
    ...(!googleMapsReady ? ["Google Maps is not configured."] : []),
    ...(!featurebaseReady ? ["Featurebase support is not configured."] : []),
    ...(!socialEncryptionReady ? ["Social connection encryption is missing or invalid."] : []),
    ...(!polarOAuthReady ? ["Polar creator payments are not configured."] : []),
    ...(!googleBookingOAuthReady ? ["Google booking OAuth is not configured."] : []),
    ...(!fathomBookingOAuthReady ? ["Fathom booking OAuth is not configured."] : []),
    ...(!runtimeEnv?.BROWSER ? ["Browser Run is not configured."] : []),
  ];
  return Response.json(
    {
      ok: healthErrors.length === 0,
      environment,
      checks: {
        isolatedData: isolationErrors.length === 0,
        r2: Boolean(runtimeEnv?.MEDIA_BUCKET),
        browserRun: Boolean(runtimeEnv?.BROWSER),
        analyticsQueue: analyticsQueueShards === 4,
        analyticsQueueShards,
        analyticsRateLimiter: Boolean(runtimeEnv?.ANALYTICS_RATE_LIMITER),
        uploadRateLimiter: Boolean(runtimeEnv?.UPLOAD_RATE_LIMITER),
        authEmailRateLimiter: Boolean(runtimeEnv?.AUTH_EMAIL_RATE_LIMITER),
        checkoutRateLimiter: Boolean(runtimeEnv?.CHECKOUT_RATE_LIMITER),
        protectedHealth: Boolean(
          typeof runtimeEnv?.HEALTH_CHECK_TOKEN === "string" &&
          runtimeEnv.HEALTH_CHECK_TOKEN.length >= 32,
        ),
        publicApiRateLimiter: Boolean(runtimeEnv?.PUBLIC_API_RATE_LIMITER),
        expensiveApiRateLimiter: Boolean(runtimeEnv?.EXPENSIVE_API_RATE_LIMITER),
        billingQueue: Boolean(runtimeEnv?.BILLING_QUEUE),
        emailQueue: Boolean(runtimeEnv?.EMAIL_QUEUE),
        referralQueue: Boolean(runtimeEnv?.REFERRAL_QUEUE),
        socialPublishQueue: Boolean(runtimeEnv?.SOCIAL_PUBLISH_QUEUE),
        supabase: supabaseReady,
        posthog: posthogReady,
        dodoBilling: dodoBillingReady,
        creatorPayments,
        googleMaps: googleMapsReady,
        featurebase: featurebaseReady,
        instagramAutoDm: instagramAutoDmReady,
        twitterAutoDm: twitterAutoDmReady,
        facebookAutoDm: facebookAutoDmReady,
        liveSocialPreviews,
        socialOAuth,
        polarOAuth: polarOAuthReady,
        googleBookingOAuth: googleBookingOAuthReady,
        fathomBookingOAuth: fathomBookingOAuthReady,
        emailDelivery: emailDelivery.ready,
        emailDeliveryMode: emailDelivery.mode,
      },
      ...(healthErrors.length ? { errors: healthErrors } : {}),
    },
    { status: healthErrors.length ? 503 : 200 },
  );
}

async function healthDetailsAuthorized(request: Request, env: unknown) {
  const expected = (env as { HEALTH_CHECK_TOKEN?: unknown } | undefined)?.HEALTH_CHECK_TOKEN;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (typeof expected !== "string" || expected.length < 32 || !provided) return false;

  const encoder = new TextEncoder();
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(providedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function handleDeploymentHealthRequest(request: Request, env: unknown) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } },
    );
  }
  const response = deploymentHealth(env);
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "authorization");
  const detailed = await healthDetailsAuthorized(request, env);
  const selected = detailed
    ? response
    : Response.json(
        { ok: response.ok },
        {
          status: response.status,
          headers: { "cache-control": "no-store", vary: "authorization" },
        },
      );
  if (request.method === "GET") return selected;
  return new Response(null, {
    status: selected.status,
    statusText: selected.statusText,
    headers: selected.headers,
  });
}

const AI_CRAWLERS = [
  { match: "ChatGPT-User", crawler: "ChatGPT", category: "AI answers" },
  { match: "OAI-SearchBot", crawler: "ChatGPT", category: "Indexing" },
  { match: "GPTBot", crawler: "ChatGPT", category: "Training" },
  { match: "Claude-User", crawler: "Claude", category: "AI answers" },
  { match: "Claude-SearchBot", crawler: "Claude", category: "Indexing" },
  { match: "ClaudeBot", crawler: "Claude", category: "Training" },
  { match: "Perplexity-User", crawler: "Perplexity", category: "AI answers" },
  { match: "PerplexityBot", crawler: "Perplexity", category: "Indexing" },
  { match: "Google-Extended", crawler: "Gemini", category: "Training" },
  { match: "DuckAssistBot", crawler: "DuckDuckGo", category: "Indexing" },
] as const;

function trackAiCrawler(request: Request, env: unknown, ctx: unknown) {
  if (request.method !== "GET") return;
  const userAgent = request.headers.get("user-agent") ?? "";
  const match = AI_CRAWLERS.find((crawler) => userAgent.includes(crawler.match));
  if (!match) return;
  const capture = captureServerEvent(
    `crawler:${match.crawler}`,
    "ai_crawler_visit",
    {
      crawler: match.crawler,
      crawler_category: match.category,
      path: redactSensitivePathname(new URL(request.url).pathname),
    },
    env,
  );
  const workerContext = ctx as WorkerContext;
  if (typeof workerContext?.waitUntil === "function") workerContext.waitUntil(capture);
  else void capture;
}

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

function sitemapBaseUrl(env: unknown) {
  const runtimeEnv = env as Record<string, unknown> | undefined;
  return typeof runtimeEnv?.VITE_PUBLIC_URL === "string" ? runtimeEnv.VITE_PUBLIC_URL : undefined;
}

function rewritePublicOrigin(document: string, baseUrl: string | undefined) {
  const origin = configuredPublicOrigin(baseUrl);
  return document
    .replace(/(<loc>)https?:\/\/[^/\s<]+/g, `$1${origin}`)
    .replace(/(^Sitemap:\s*)https?:\/\/[^/\s]+/gm, `$1${origin}`);
}

function sitemapDatabaseReady(env: unknown) {
  const runtimeEnv = env as Record<string, unknown> | undefined;
  return (
    typeof runtimeEnv?.SUPABASE_URL === "string" &&
    typeof runtimeEnv?.SUPABASE_SERVICE_ROLE_KEY === "string"
  );
}

function sitemapResponse(request: Request, xml: string, status = 200) {
  return new Response(request.method === "HEAD" ? null : xml, {
    status,
    headers: {
      "cache-control":
        status === 200 ? "public, max-age=300, stale-while-revalidate=3600" : "no-store",
      "content-type": "application/xml; charset=utf-8",
      ...(status === 503 ? { "retry-after": "60" } : {}),
    },
  });
}

async function generatePublicSitemapResponse(request: Request, env: unknown) {
  const path = new URL(request.url).pathname;
  const baseUrl = sitemapBaseUrl(env);
  const requestHost = new URL(request.url).hostname.toLowerCase();
  const publicHost = new URL(configuredPublicOrigin(baseUrl)).hostname.toLowerCase();
  if (
    requestHost !== publicHost &&
    requestHost !== `www.${publicHost}` &&
    requestHost !== "localhost" &&
    requestHost !== "127.0.0.1" &&
    !requestHost.endsWith(".workers.dev") &&
    !requestHost.endsWith(".pages.dev")
  ) {
    return sitemapResponse(request, '<?xml version="1.0" encoding="UTF-8"?>\n', 404);
  }
  const shard = parseSitemapShardPath(path);
  if (path !== "/sitemap.xml" && !shard) {
    return sitemapResponse(request, '<?xml version="1.0" encoding="UTF-8"?>\n', 404);
  }

  if (request.method === "HEAD") {
    return sitemapResponse(request, "");
  }

  if (!sitemapDatabaseReady(env)) {
    return path === "/sitemap.xml"
      ? sitemapResponse(request, renderSitemapIndex({ profiles: 0, products: 0 }, baseUrl))
      : sitemapResponse(request, '<?xml version="1.0" encoding="UTF-8"?>\n', 503);
  }

  try {
    if (path === "/sitemap.xml") {
      return sitemapResponse(request, renderSitemapIndex(await loadSitemapManifest(), baseUrl));
    }
    return sitemapResponse(
      request,
      renderSitemapUrlSet(await loadSitemapShard(shard!.kind, shard!.shard, undefined, baseUrl)),
    );
  } catch (error) {
    console.error("Public sitemap generation failed", error);
    return sitemapResponse(request, '<?xml version="1.0" encoding="UTF-8"?>\n', 503);
  }
}

function sitemapCacheRequest(request: Request) {
  const key = new URL(request.url);
  key.search = "?__bento_sitemap_cache=v1";
  return new Request(key.toString(), { method: "GET" });
}

async function publicSitemapResponse(
  request: Request,
  env: unknown,
  context: WorkerContext | undefined,
) {
  const cacheAllowed =
    request.method === "GET" &&
    getDeploymentEnvironment(env as Record<string, unknown> | undefined) === "production" &&
    !request.headers.has("authorization");
  const cache =
    cacheAllowed && typeof caches !== "undefined"
      ? (caches as CacheStorage & { default: Cache }).default
      : null;
  const key = cache ? sitemapCacheRequest(request) : null;
  if (cache && key) {
    try {
      const cached = await cache.match(key);
      if (cached) return cached;
    } catch (error) {
      console.warn("[sitemap-cache] read failed; continuing without cache", error);
    }
  }

  const response = await generatePublicSitemapResponse(request, env);
  if (cache && key && response.status === 200) {
    const write = cache.put(key, response.clone()).catch((error) => {
      console.warn("[sitemap-cache] write failed; response was still served", error);
    });
    if (typeof context?.waitUntil === "function") context.waitUntil(write);
    else await write;
  }
  return response;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} - try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  response: Response,
  request: Request,
  env: unknown,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  const error = consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`);
  console.error(error);
  await captureServerException(
    error,
    "bento-worker",
    {
      surface: "ssr_response",
      path: redactSensitivePathname(new URL(request.url).pathname),
      method: request.method,
    },
    env,
  );
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: CloudflareRequest) {
    const env = request.runtime?.cloudflare?.env ?? globalThis.__env__;
    const ctx = request.runtime?.cloudflare?.context;
    hydrateRuntimeEnv(env);

    const canonicalRedirect = routeCanonicalHostname(
      request,
      env as { VITE_APP_URL?: unknown; VITE_PUBLIC_URL?: unknown } | undefined,
    );
    if (canonicalRedirect) {
      return withDeploymentHeaders(canonicalRedirect, env, request);
    }

    const path = new URL(request.url).pathname;
    const seoMethod = request.method === "GET" || request.method === "HEAD";
    if (seoMethod && (path === "/sitemap.xml" || path.startsWith("/sitemaps/"))) {
      return withDeploymentHeaders(await publicSitemapResponse(request, env, ctx), env, request);
    }
    const seoFile = !seoMethod
      ? undefined
      : path === "/robots.txt"
        ? [rewritePublicOrigin(robotsTxt, sitemapBaseUrl(env)), "text/plain; charset=utf-8"]
        : path === "/llms.txt"
          ? [llmsTxt, "text/plain; charset=utf-8"]
          : undefined;
    if (seoFile) {
      return withDeploymentHeaders(
        new Response(request.method === "HEAD" ? null : seoFile[0], {
          headers: {
            "cache-control": "public, max-age=300, stale-while-revalidate=3600",
            "content-type": seoFile[1],
          },
        }),
        env,
        request,
      );
    }

    if (path === "/api/health") {
      return withDeploymentHeaders(await handleDeploymentHealthRequest(request, env), env, request);
    }

    const isolationErrors = getStagingIsolationErrors(env as Record<string, unknown> | undefined);
    if (isolationErrors.length) {
      return withDeploymentHeaders(
        Response.json(
          { error: "Staging is not safely configured.", checks: isolationErrors },
          { status: 503 },
        ),
        env,
        request,
      );
    }

    const mcpResponse = await handleBentoMcpRequest(request, env?.VITE_APP_URL);
    if (mcpResponse) return withDeploymentHeaders(mcpResponse, env, request);

    trackAiCrawler(request, env, ctx);

    const referralRedirect = await handleReferralRedirect(request);
    if (referralRedirect) return withDeploymentHeaders(referralRedirect, env, request);

    const cachedPage = await readPublicPageCache(request, env);
    if (cachedPage) return withDeploymentHeaders(cachedPage, env, request);

    if (path === "/api/events") {
      return withDeploymentHeaders(
        await handleAnalyticsEventRequest(request, env as RuntimeEnv, ctx),
        env,
        request,
      );
    }

    if (path.startsWith(OPEN_GRAPH_IMAGE_PATH)) {
      if (!env?.MEDIA_BUCKET) {
        return withDeploymentHeaders(
          Response.json({ error: "Preview storage is not configured" }, { status: 503 }),
          env,
          request,
        );
      }
      const previewResponse = await handleOpenGraphImageRequest(request, env);
      if (previewResponse) return withDeploymentHeaders(previewResponse, env, request);
    }

    if (path === "/api/email/unsubscribe") {
      return withDeploymentHeaders(await handleEmailUnsubscribeRequest(request), env, request);
    }

    if (path === "/api/webhooks/instagram" && request.method === "GET") {
      return withDeploymentHeaders(await handleInstagramWebhookVerification(request), env, request);
    }
    if (path === "/api/webhooks/twitter" && request.method === "GET") {
      return withDeploymentHeaders(await handleTwitterWebhookCrc(request), env, request);
    }
    if (path === "/api/webhooks/facebook" && request.method === "GET") {
      return withDeploymentHeaders(await handleFacebookWebhookVerification(request), env, request);
    }

    if (path === "/api/integrations/instagram/data-deletion/status") {
      return withDeploymentHeaders(
        await handleInstagramDataDeletionStatusRequest(request),
        env,
        request,
      );
    }

    if (path === GOOGLE_MAP_EMBED_PATH) {
      const mapResponse = await handleGoogleMapEmbedRequest(request, env);
      if (mapResponse) return withDeploymentHeaders(mapResponse, env, request);
    }
    if (
      path === "/api/storage/upload" ||
      path === "/api/storage/manage" ||
      path.startsWith("/cdn/")
    ) {
      if (!env?.MEDIA_BUCKET || !ctx) {
        return withDeploymentHeaders(
          Response.json({ error: "Cloudflare R2 is not configured" }, { status: 503 }),
          env,
          request,
        );
      }
      const storageResponse = await handleR2StorageRequest(request, env, ctx);
      if (storageResponse) return withDeploymentHeaders(storageResponse, env, request);
    }
    if (path.startsWith(COMMERCE_DOWNLOAD_PATH)) {
      if (!env?.MEDIA_BUCKET) {
        return withDeploymentHeaders(
          Response.json({ error: "Cloudflare R2 is not configured" }, { status: 503 }),
          env,
          request,
        );
      }
      const downloadResponse = await handleCommerceDownloadRequest(request, env, ctx);
      if (downloadResponse) return withDeploymentHeaders(downloadResponse, env, request);
    }

    // Payment webhooks need the raw request body for signature verification, so
    // handle them here before the SSR handler (which would consume/parse the body).
    if (request.method === "POST" && new URL(request.url).pathname === "/api/webhooks/dodo") {
      return withDeploymentHeaders(await handleDodoWebhook(request, env), env, request);
    }
    if (request.method === "POST" && path.startsWith("/api/webhooks/dodo/direct/")) {
      const connectionId = path.slice("/api/webhooks/dodo/direct/".length);
      return withDeploymentHeaders(
        await handleDodoCreatorWebhook(request, connectionId),
        env,
        request,
      );
    }
    if (request.method === "POST" && path.startsWith("/api/webhooks/polar/")) {
      const connectionId = path.slice("/api/webhooks/polar/".length);
      return withDeploymentHeaders(await handlePolarWebhook(request, connectionId), env, request);
    }
    if (request.method === "POST" && path === "/api/webhooks/stripe") {
      return withDeploymentHeaders(await handleStripeWebhook(request), env, request);
    }
    if (request.method === "POST" && path.startsWith("/api/webhooks/stripe/direct/")) {
      const connectionId = path.slice("/api/webhooks/stripe/direct/".length);
      return withDeploymentHeaders(
        await handleDirectStripeWebhook(request, connectionId),
        env,
        request,
      );
    }
    if (request.method === "POST" && path === "/api/webhooks/paypal") {
      return withDeploymentHeaders(await handlePayPalWebhook(request), env, request);
    }
    if (request.method === "POST" && path.startsWith("/api/webhooks/paypal/direct/")) {
      const connectionId = path.slice("/api/webhooks/paypal/direct/".length);
      return withDeploymentHeaders(
        await handleDirectPayPalWebhook(request, connectionId),
        env,
        request,
      );
    }
    if (request.method === "POST" && path.startsWith("/api/webhooks/razorpay/direct/")) {
      const connectionId = path.slice("/api/webhooks/razorpay/direct/".length);
      return withDeploymentHeaders(
        await handleRazorpayWebhook(request, connectionId),
        env,
        request,
      );
    }
    if (request.method === "POST" && path.startsWith("/api/webhooks/creem/direct/")) {
      const connectionId = path.slice("/api/webhooks/creem/direct/".length);
      return withDeploymentHeaders(await handleCreemWebhook(request, connectionId), env, request);
    }
    if (request.method === "POST" && path === "/api/webhooks/resend") {
      return withDeploymentHeaders(await handleResendWebhook(request), env, request);
    }
    if (request.method === "POST" && path === "/api/webhooks/instagram") {
      return withDeploymentHeaders(
        await handleInstagramWebhook(request, (env as RuntimeEnv | undefined)?.INSTAGRAM_DM_QUEUE),
        env,
        request,
      );
    }
    if (request.method === "POST" && path === "/api/webhooks/twitter") {
      return withDeploymentHeaders(
        await handleTwitterWebhook(request, (env as RuntimeEnv | undefined)?.TWITTER_DM_QUEUE),
        env,
        request,
      );
    }
    if (request.method === "POST" && path === "/api/webhooks/facebook") {
      return withDeploymentHeaders(
        await handleFacebookWebhook(request, (env as RuntimeEnv | undefined)?.FACEBOOK_DM_QUEUE),
        env,
        request,
      );
    }
    if (request.method === "POST") {
      if (path === "/api/integrations/instagram/deauthorize") {
        return withDeploymentHeaders(
          await handleInstagramDataRequest(request, "deauthorize"),
          env,
          request,
        );
      }
      if (path === "/api/integrations/instagram/data-deletion") {
        return withDeploymentHeaders(
          await handleInstagramDataRequest(request, "delete"),
          env,
          request,
        );
      }
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response, request, env);
      const cacheAware = await storePublicPageCache(request, normalized, env, ctx);
      return withDeploymentHeaders(cacheAware, env, request);
    } catch (error) {
      console.error(error);
      const capture = captureServerException(
        error,
        "bento-worker",
        {
          surface: "worker_fetch",
          path: redactSensitivePathname(new URL(request.url).pathname),
          method: request.method,
        },
        env,
      );
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(capture);
      else void capture;
      return withDeploymentHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
        env,
        request,
      );
    }
  },
  async queue(
    batch: MessageBatch<
      | AnalyticsEvent
      | DodoQueueMessage
      | EmailQueueMessage
      | SocialPublishMessage
      | SocialInsightsBackfillMessage
      | ReferralQueueMessage
      | InstagramDmQueueMessage
      | TwitterDmQueueMessage
      | FacebookDmQueueMessage
    >,
    env: RuntimeEnv,
  ) {
    hydrateRuntimeEnv(env);
    const billingMessages = batch.messages
      .map((message) => message.body)
      .filter((body): body is DodoQueueMessage => body.kind === "dodo_webhook");
    const emailMessages = batch.messages
      .map((message) => message.body)
      .filter(
        (body): body is Extract<EmailQueueMessage, { kind: "email_outbox_kick" }> =>
          body.kind === "email_outbox_kick",
      );
    const audienceCampaignMessages = batch.messages.filter(
      (message): message is Message<Extract<EmailQueueMessage, { kind: "audience_campaign" }>> =>
        "kind" in message.body && message.body.kind === "audience_campaign",
    );
    const socialMessages = batch.messages
      .map((message) => message.body)
      .filter((body): body is SocialPublishMessage => body.kind === "social_publish");
    const socialInsightsMessages = batch.messages.filter(
      (message): message is Message<SocialInsightsBackfillMessage> =>
        "kind" in message.body && message.body.kind === "social_insights_backfill",
    );
    const referralMessages = batch.messages.filter(
      (message): message is Message<ReferralQueueMessage> =>
        "kind" in message.body && message.body.kind === "referral_reach_verify",
    );
    const instagramDmMessages = batch.messages.filter(
      (message): message is Message<InstagramDmQueueMessage> =>
        "kind" in message.body &&
        (message.body.kind === "instagram_dm_event" ||
          message.body.kind === "instagram_comment_reconcile"),
    );
    const twitterDmMessages = batch.messages.filter(
      (message): message is Message<TwitterDmQueueMessage> =>
        "kind" in message.body &&
        (message.body.kind === "twitter_dm_event" || message.body.kind === "twitter_dm_reconcile"),
    );
    const facebookDmMessages = batch.messages.filter(
      (message): message is Message<FacebookDmQueueMessage> =>
        "kind" in message.body && message.body.kind === "facebook_dm_event",
    );
    const analyticsMessages = batch.messages
      .map((message) => message.body)
      .filter(
        (body): body is AnalyticsEvent =>
          !("kind" in body) ||
          (body.kind !== "dodo_webhook" &&
            body.kind !== "email_outbox_kick" &&
            body.kind !== "audience_campaign" &&
            body.kind !== "social_publish" &&
            body.kind !== "social_insights_backfill" &&
            body.kind !== "referral_reach_verify" &&
            body.kind !== "instagram_dm_event" &&
            body.kind !== "instagram_comment_reconcile" &&
            body.kind !== "twitter_dm_event" &&
            body.kind !== "twitter_dm_reconcile" &&
            body.kind !== "facebook_dm_event"),
      );
    for (const message of billingMessages) {
      await processVerifiedDodoEvent(message.event, message.webhookId);
    }
    for (const message of audienceCampaignMessages) {
      await processAudienceCampaignQueueMessage(message);
    }
    if (emailMessages.length) {
      const limit = Math.min(100, Math.max(25, emailMessages.length * 25));
      const result = await processEmailOutbox(limit);
      if (result.claimed === limit) {
        await env.EMAIL_QUEUE?.send({ kind: "email_outbox_kick" });
      }
    }
    for (const message of socialMessages) await processSocialPublishMessage(message);
    for (const message of socialInsightsMessages) {
      const body = normalizeSocialInsightsBackfillMessage(message.body);
      try {
        await processSocialInsightsBackfillMessage(body, env.SOCIAL_INSIGHTS_QUEUE);
        message.ack();
      } catch (error) {
        console.error("[social-insights] historical import failed", {
          messageId: message.id,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : "Unknown queue error",
        });
        const disposition = socialInsightsDeliveryDisposition(error, message.attempts);
        if (disposition === "retry") {
          await releaseSocialInsightsBackfillMessage(body);
          message.retry({
            delaySeconds: Math.min(900, 30 * 2 ** Math.max(0, message.attempts - 1)),
          });
        } else {
          await failSocialInsightsBackfillMessage(body, error);
          if (disposition === "dead_letter") message.retry();
          else message.ack();
        }
      }
    }
    for (const message of referralMessages) {
      try {
        await processReferralQueueMessage(message.body);
        message.ack();
      } catch (error) {
        console.error("[referral] reach verification failed", {
          messageId: message.id,
          attempt: message.attempts,
          error: error instanceof Error ? error.message : "Unknown queue error",
        });
        message.retry({
          delaySeconds: Math.min(900, 30 * 2 ** Math.max(0, message.attempts - 1)),
        });
      }
    }
    for (const message of instagramDmMessages) {
      try {
        await processInstagramDmQueueMessage(message.body, env.INSTAGRAM_DM_QUEUE);
        message.ack();
      } catch (error) {
        const delaySeconds = getInstagramDmRetryDelaySeconds(error, message.attempts);
        console.error("[instagram-auto-dm] queue delivery failed", {
          messageId: message.id,
          attempt: message.attempts,
          retryInSeconds: delaySeconds,
          error: error instanceof Error ? error.message : "Unknown queue error",
        });
        message.retry({ delaySeconds });
      }
    }
    for (const message of twitterDmMessages) {
      try {
        await processTwitterDmQueueMessage(message.body, env.TWITTER_DM_QUEUE);
        message.ack();
      } catch (error) {
        const delaySeconds = getTwitterDmRetryDelaySeconds(error, message.attempts);
        console.error("[twitter-auto-dm] queue delivery failed", {
          messageId: message.id,
          attempt: message.attempts,
          retryInSeconds: delaySeconds,
          error: error instanceof Error ? error.message : "Unknown queue error",
        });
        message.retry({ delaySeconds });
      }
    }
    for (const message of facebookDmMessages) {
      try {
        await processFacebookDmQueueMessage(message.body);
        message.ack();
      } catch (error) {
        const delaySeconds = getFacebookDmRetryDelaySeconds(error, message.attempts);
        console.error("[facebook-auto-dm] queue delivery failed", {
          messageId: message.id,
          attempt: message.attempts,
          retryInSeconds: delaySeconds,
          error: error instanceof Error ? error.message : "Unknown queue error",
        });
        message.retry({ delaySeconds });
      }
    }
    if (
      audienceCampaignMessages.length +
        emailMessages.length +
        socialInsightsMessages.length +
        referralMessages.length +
        instagramDmMessages.length +
        twitterDmMessages.length +
        facebookDmMessages.length ===
      batch.messages.length
    )
      return;
    if (analyticsMessages.length) {
      await insertAnalyticsEventBatch(analyticsMessages);
    }
    batch.ackAll();
  },
  async scheduled(controller: ScheduledController, env: RuntimeEnv) {
    hydrateRuntimeEnv(env);
    try {
      if (controller.cron === "0 9 * * *") {
        await enqueueLifecycleEmails();
        await reconcileReferralLedger();
      }
      const audienceCampaignResult = await enqueueDueAudienceCampaigns(env.EMAIL_QUEUE);
      await env.EMAIL_QUEUE?.send({ kind: "email_outbox_kick" });
      const socialResult = await enqueueDueSocialPosts(env.SOCIAL_PUBLISH_QUEUE, env);
      const socialInsightsRecovery = await requeueStaleSocialInsightsBackfills(
        env.SOCIAL_INSIGHTS_QUEUE,
      );
      const referralResult = await enqueueDueReferralReach(env.REFERRAL_QUEUE);
      const socialHealth = await auditSocialConnections();
      const instagramHealth = await auditInstagramConnections();
      const instagramReconciliation = await enqueueInstagramCommentReconciliations(
        env.INSTAGRAM_DM_QUEUE,
      );
      const twitterReconciliation = await enqueueTwitterDmReconciliations(env.TWITTER_DM_QUEUE);
      const facebookHealth = await auditFacebookConnections();
      const bookingResult = await processBookingFollowups();
      const fulfillmentResult = await reconcileCommerceFulfillment();
      const priorityDmNotificationResult = await reconcilePriorityDmNotifications();
      const expiredSubscriptions = await expireCommerceSubscriptionAccess();
      const checkoutResult = await expireStaleCommerceCheckouts();
      if (
        bookingResult.reviewsQueued > 0 ||
        bookingResult.recordingsReady > 0 ||
        bookingResult.calendarCancellationsCleaned > 0 ||
        bookingResult.bookingRemindersQueued > 0 ||
        bookingResult.webinarRemindersQueued > 0 ||
        bookingResult.webinarReplaysQueued > 0
      ) {
        console.log("[booking] processed call follow-ups", bookingResult);
      }
      if (checkoutResult.expired > 0) {
        console.log("[commerce] expired stale checkouts", checkoutResult);
      }
      if (expiredSubscriptions > 0) {
        console.log("[commerce] expired subscription access", { expiredSubscriptions });
      }
      if (
        fulfillmentResult.reconciledSessions > 0 ||
        fulfillmentResult.repairedOrders > 0 ||
        fulfillmentResult.failedOrders > 0
      ) {
        console.log("[commerce] repaired fulfillment state", fulfillmentResult);
      }
      if (priorityDmNotificationResult.repaired > 0 || priorityDmNotificationResult.failed > 0) {
        console.log("[email] repaired Priority DM notifications", priorityDmNotificationResult);
      }
      if (socialResult.queued > 0) console.log("[social] queued scheduled posts", socialResult);
      if (socialInsightsRecovery.queued > 0)
        console.log("[social-insights] stale imports requeued", socialInsightsRecovery);
      if (referralResult.queued > 0)
        console.log("[referral] queued reach verification", referralResult);
      if (socialHealth.checked > 0) console.log("[social] connection health audit", socialHealth);
      if (
        instagramHealth.checked > 0 ||
        instagramHealth.actionRequired > 0 ||
        instagramHealth.transientFailures > 0
      ) {
        console.log("[instagram-auto-dm] connection health audit", instagramHealth);
      }
      if (instagramReconciliation.queued > 0) {
        console.log(
          "[instagram-auto-dm] queued missed-comment reconciliation",
          instagramReconciliation,
        );
      }
      if (twitterReconciliation.queued > 0) {
        console.log("[twitter-auto-dm] queued missed-event reconciliation", twitterReconciliation);
      }
      if (
        facebookHealth.checked > 0 ||
        facebookHealth.actionRequired > 0 ||
        facebookHealth.transientFailures > 0
      ) {
        console.log("[facebook-auto-dm] connection health audit", facebookHealth);
      }
      if (audienceCampaignResult.claimed > 0) {
        console.log("[email] scheduled campaigns queued", audienceCampaignResult);
      }
    } catch (error) {
      console.error("[scheduled] background processing failed", error);
      await captureServerException(error, "bento-scheduled-work", {
        surface: "scheduled_work",
      });
      throw error;
    }
  },
};
