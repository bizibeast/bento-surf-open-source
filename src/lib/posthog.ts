import { createClientOnlyFn } from "@tanstack/react-start";
import posthog from "posthog-js";
import { redactSensitivePathname } from "./safe-url";

export type ProductEventName =
  | "signup_started"
  | "signup_completed"
  | "login_completed"
  | "username_claimed"
  | "first_block_added"
  | "onboarding_completed"
  | "onboarding_plan_selected"
  | "onboarding_upgrade_prompt_viewed"
  | "onboarding_upgrade_skipped"
  | "onboarding_checklist_opened"
  | "onboarding_step_clicked"
  | "onboarding_checklist_completed"
  | "onboarding_checklist_dismissed"
  | "customer_hub_opened"
  | "support_messenger_opened"
  | "support_portal_fallback_opened"
  | "feedback_widget_opened"
  | "feedback_portal_opened"
  | "product_updates_opened"
  | "block_added"
  | "share_link_copied"
  | "upgrade_clicked"
  | "checkout_started"
  | "custom_domain_connected"
  | "commerce_checkout_started"
  | "commerce_lead_submitted"
  | "commerce_affiliate_clicked"
  | "free_tool_started"
  | "free_tool_copied"
  | "free_tool_product_cta_clicked"
  | "outbound_link_clicked";

export const PRODUCT_FEATURE_FLAGS = {
  sessionReplay: "is-session-replay-enabled",
} as const;

export type ProductFeatureFlag = (typeof PRODUCT_FEATURE_FLAGS)[keyof typeof PRODUCT_FEATURE_FLAGS];

let initialized = false;
let identifiedUserId: string | null = null;
let replayablePath = false;
let replayFlagEnabled = false;
let heatmapsEnabled = false;
let firstTouch: Record<string, string> = {};
let outboundTrackingAttached = false;

const FIRST_TOUCH_KEY = "bento:first-touch:v1";
const PRODUCT_ANALYTICS_PATHS = new Set([
  "/",
  "/signup",
  "/login",
  "/onboarding",
  "/link",
  "/analytics",
]);

function safeCampaignValue(value: string | null): string | null {
  const cleaned = value?.trim().slice(0, 120);
  return cleaned || null;
}

function sourceFromHost(hostname: string | null) {
  if (!hostname) return "Direct";
  const host = hostname.replace(/^www\./, "").toLowerCase();
  const known: Record<string, string> = {
    "google.com": "Google",
    "google.co.in": "Google",
    "bing.com": "Bing",
    "duckduckgo.com": "DuckDuckGo",
    "instagram.com": "Instagram",
    "l.instagram.com": "Instagram",
    "x.com": "X",
    "twitter.com": "X",
    "t.co": "X",
    "youtube.com": "YouTube",
    "reddit.com": "Reddit",
    "linkedin.com": "LinkedIn",
    "facebook.com": "Facebook",
    "tiktok.com": "TikTok",
    "github.com": "GitHub",
  };
  return known[host] ?? host;
}

function getFirstTouchAttribution(): Record<string, string> {
  try {
    const stored = window.localStorage.getItem(FIRST_TOUCH_KEY);
    if (stored) return JSON.parse(stored) as Record<string, string>;

    const current = new URL(window.location.href);
    let referringDomain: string | null = null;
    try {
      const referrer = document.referrer ? new URL(document.referrer) : null;
      if (referrer && referrer.origin !== current.origin) referringDomain = referrer.hostname;
    } catch {
      // Invalid referrers are treated as direct traffic.
    }

    const utmSource = safeCampaignValue(current.searchParams.get("utm_source"));
    const attribution = Object.fromEntries(
      Object.entries({
        initial_source: utmSource ?? sourceFromHost(referringDomain),
        initial_referring_domain: referringDomain ?? "Direct",
        initial_landing_path: redactSensitivePathname(current.pathname),
        initial_utm_source: utmSource,
        initial_utm_medium: safeCampaignValue(current.searchParams.get("utm_medium")),
        initial_utm_campaign: safeCampaignValue(current.searchParams.get("utm_campaign")),
        initial_utm_content: safeCampaignValue(current.searchParams.get("utm_content")),
        initial_utm_term: safeCampaignValue(current.searchParams.get("utm_term")),
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(attribution));
    return attribution;
  } catch {
    return {
      initial_source: "Direct",
      initial_landing_path: redactSensitivePathname(window.location.pathname),
    };
  }
}

function attachOutboundLinkTracking() {
  if (outboundTrackingAttached) return;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = target?.getAttribute("href");
    if (!href) return;
    try {
      const destination = new URL(href, window.location.origin);
      if (!destination.protocol.startsWith("http") || destination.origin === window.location.origin)
        return;
      posthog.capture("outbound_link_clicked", {
        destination_host: destination.hostname.replace(/^www\./, ""),
      });
    } catch {
      // Invalid or non-web links are not analytics destinations.
    }
  });
  outboundTrackingAttached = true;
}

function applySessionRecordingState() {
  if (replayablePath && replayFlagEnabled) posthog.startSessionRecording();
  else posthog.stopSessionRecording();
}

function applyHeatmapState() {
  posthog.set_config({ enable_heatmaps: heatmapsEnabled });
}

function stripUrlSecrets(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value, window.location.origin);
    return `${url.origin}${redactSensitivePathname(url.pathname)}`;
  } catch {
    return value;
  }
}

function initPostHog(): boolean {
  if (initialized) return true;
  const key = (import.meta.env.VITE_PUBLIC_POSTHOG_KEY as string | undefined)?.trim();
  const host = (
    (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com"
  ).replace(/\/$/, "");
  if (!key) return false;

  posthog.init(key, {
    api_host: host,
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: "identified_only",
    flag_keys: [PRODUCT_FEATURE_FLAGS.sessionReplay],
    feature_flag_request_timeout_ms: 2_000,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    before_send: (event) => {
      if (!event) return event;
      event.properties.$current_url = stripUrlSecrets(event.properties.$current_url);
      event.properties.$referrer = stripUrlSecrets(event.properties.$referrer);
      if (typeof event.properties.path === "string") {
        event.properties.path = redactSensitivePathname(event.properties.path);
      }
      if (typeof event.properties.$pathname === "string") {
        event.properties.$pathname = redactSensitivePathname(event.properties.$pathname);
      }
      return event;
    },
    enable_heatmaps: false,
    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "[data-private]",
    },
  });
  firstTouch = getFirstTouchAttribution();
  posthog.register(firstTouch);
  attachOutboundLinkTracking();
  posthog.onFeatureFlags((_flags, _variants, { errorsLoading } = {}) => {
    replayFlagEnabled =
      !errorsLoading &&
      posthog.getFeatureFlagResult(PRODUCT_FEATURE_FLAGS.sessionReplay)?.enabled === true;
    applySessionRecordingState();
  });
  initialized = true;
  return true;
}

export const identifyProductUser = createClientOnlyFn((userId: string | null) => {
  // Route synchronization initializes PostHog only on the product allowlist.
  // Auth state also runs on creator pages and /admin, so it must never start
  // the SDK by itself on an excluded route.
  if (!initialized) return;
  if (!userId) {
    if (identifiedUserId) posthog.reset();
    identifiedUserId = null;
    return;
  }
  if (identifiedUserId === userId) return;
  posthog.identify(userId);
  posthog.people.set_once(firstTouch);
  identifiedUserId = userId;
});

export const captureProductEvent = createClientOnlyFn(
  (event: ProductEventName, properties: Record<string, string | number | boolean | null> = {}) => {
    if (!initPostHog()) return;
    posthog.capture(event, properties);
  },
);

export const captureProductPageview = createClientOnlyFn((pathname: string) => {
  if (!initPostHog()) return;
  const safePathname = redactSensitivePathname(pathname);
  posthog.capture("$pageview", {
    $current_url: `${window.location.origin}${safePathname}`,
    path: safePathname,
  });
});

export const captureProductException = createClientOnlyFn(
  (error: unknown, properties: Record<string, string | number | boolean | null> = {}) => {
    if (!initPostHog()) return;
    posthog.captureException(error, properties);
  },
);

export const setProductSessionRecording = createClientOnlyFn((enabled: boolean) => {
  if (!initialized && !enabled) return;
  if (!initPostHog()) return;
  replayablePath = enabled;
  applySessionRecordingState();
});

export const setProductHeatmaps = createClientOnlyFn((enabled: boolean) => {
  if (!initialized && !enabled) return;
  if (!initPostHog()) return;
  heatmapsEnabled = enabled;
  applyHeatmapState();
});

/** Typed, fail-closed flag access for future release flags and experiments. */
export const isProductFeatureEnabled = createClientOnlyFn((flag: ProductFeatureFlag) => {
  if (!initPostHog()) return false;
  return posthog.getFeatureFlagResult(flag)?.enabled === true;
});

export function isTrackedProductPath(pathname: string) {
  return (
    PRODUCT_ANALYTICS_PATHS.has(pathname) ||
    pathname === "/tools" ||
    pathname.startsWith("/tools/") ||
    pathname === "/store" ||
    pathname.startsWith("/p/") ||
    /^\/@[^/]+\/products\/[^/]+(?:\/success)?\/?$/.test(pathname)
  );
}

export function isReplayableProductPath(pathname: string) {
  return (
    PRODUCT_ANALYTICS_PATHS.has(pathname) ||
    (pathname.startsWith("/p/") && !pathname.endsWith("/success")) ||
    /^\/@[^/]+\/products\/[^/]+\/?$/.test(pathname)
  );
}

export const isHeatmapProductPath = isReplayableProductPath;
