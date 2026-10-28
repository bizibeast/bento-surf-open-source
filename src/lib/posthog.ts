import { createClientOnlyFn } from "@tanstack/react-start";
import posthog from "posthog-js";
import { readFirstLanding } from "./first-landing";
import { redactSensitivePathname } from "./safe-url";
import { isFreshOAuthSignup, isTestEmail, resolveFirstTouch } from "./analytics-identity";
import {
  isHeatmapProductPath,
  isReplayableProductPath,
  isTrackedProductPath,
} from "./posthog-paths";

export { isHeatmapProductPath, isReplayableProductPath, isTrackedProductPath };

export type ProductEventName =
  | "signup_started"
  | "signup_completed"
  | "login_completed"
  | "username_claimed"
  | "first_block_added"
  | "app_setup_complete"
  | "app_setup_resumed"
  | "app_setup_skipped"
  | "onboarding_workspace_ready"
  | "onboarding_preparation_ready"
  | "onboarding_checkout_started"
  | "onboarding_checkout_failed"
  | "onboarding_checkout_returned"
  | "onboarding_checkout_retry"
  | "plan_checkout_failed"
  | "payments_checkout_failed"
  | "onboarding_first_result_used"
  | "onboarding_step_completed"
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
  | "upgrade_dialog_opened"
  | "upgrade_banner_viewed"
  | "upgrade_banner_clicked"
  | "upgrade_banner_dismissed"
  | "trial_cta_clicked"
  | "checkout_started"
  | "onboarding_showcase_viewed"
  | "onboarding_showcase_completed"
  | "onboarding_showcase_skipped"
  | "brain_draft_succeeded"
  | "brain_draft_failed"
  | "connect_payments_clicked"
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
// Stable per tab: avoid recording every paid replay/heatmap session after a broad flag rollout.
const sampledVisualAnalytics = Math.random() < 0.1;
let heatmapsEnabled = false;
let firstTouch: Record<string, string> = {};
let outboundTrackingAttached = false;

const FIRST_TOUCH_KEY = "bento:first-touch:v1";

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
  if (replayablePath && replayFlagEnabled && sampledVisualAnalytics)
    posthog.startSessionRecording();
  else posthog.stopSessionRecording();
}

function applyHeatmapState() {
  posthog.set_config({ enable_heatmaps: heatmapsEnabled && sampledVisualAnalytics });
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
    capture_pageleave: false,
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
  if (pendingIdentity !== undefined) {
    const identity = pendingIdentity;
    pendingIdentity = undefined;
    applyIdentity(identity);
  }
  return true;
}

export type ProductUser = {
  id: string;
  email?: string | null;
  createdAt?: string | null;
  provider?: string | null;
};

// Auth can resolve before route synchronization initializes the SDK. Remember the latest
// identity so it is applied as soon as an allowlisted route starts PostHog.
let pendingIdentity: ProductUser | null | undefined;

const SIGNUP_CAPTURED_PREFIX = "bento:signup-captured:";

function signupAlreadyCaptured(userId: string) {
  try {
    return window.localStorage.getItem(`${SIGNUP_CAPTURED_PREFIX}${userId}`) === "1";
  } catch {
    return false;
  }
}

function rememberSignupCaptured(userId: string) {
  try {
    window.localStorage.setItem(`${SIGNUP_CAPTURED_PREFIX}${userId}`, "1");
  } catch {
    /* Private mode: the 10 minute window still bounds duplicates. */
  }
}

/**
 * Flags this browser's events as test traffic. Only the boolean leaves the browser; the
 * email itself is never sent to PostHog.
 */
function applyTestAccountFlag(email: string | null | undefined) {
  if (!isTestEmail(email)) return;
  posthog.register({ is_test_account: true });
  posthog.people.set({ is_test_account: true, $internal_or_test_user: true });
}

function firstTouchProperties() {
  const touch = resolveFirstTouch(
    posthog.get_property("$initial_person_info"),
    firstTouch,
    readFirstLanding(),
  );
  if (touch.first_landing_path) {
    touch.first_landing_path = redactSensitivePathname(touch.first_landing_path);
  }
  return touch;
}

function captureSignupCompletedNow(
  method: string,
  properties: Record<string, string | number | boolean | null>,
  userId: string | null,
) {
  const touch = firstTouchProperties();
  const setOnce = Object.fromEntries(Object.entries(touch).filter(([, value]) => value !== null));
  // $set_once rides in capture options; it only reaches a person once identified.
  posthog.capture(
    "signup_completed",
    { method, ...properties, ...touch },
    Object.keys(setOnce).length ? { $set_once: setOnce } : undefined,
  );
  if (userId) rememberSignupCaptured(userId);
}

function applyIdentity(user: ProductUser | null) {
  if (!user) {
    if (identifiedUserId) posthog.reset();
    identifiedUserId = null;
    return;
  }
  if (identifiedUserId === user.id) return;
  posthog.identify(user.id);
  posthog.people.set_once(firstTouch);
  identifiedUserId = user.id;
  applyTestAccountFlag(user.email);
  // Email signups are captured on the signup form. OAuth accounts only become known
  // here, after the provider redirects back, so capture their signup once.
  if (
    !signupAlreadyCaptured(user.id) &&
    isFreshOAuthSignup({ provider: user.provider, createdAt: user.createdAt })
  )
    captureSignupCompletedNow(user.provider ?? "oauth", { source: "oauth_return" }, user.id);
}

export const identifyProductUser = createClientOnlyFn((user: ProductUser | string | null) => {
  const normalized = typeof user === "string" ? { id: user } : user;
  // Route synchronization initializes PostHog only on the product allowlist.
  // Auth state also runs on creator pages and /admin, so it must never start
  // the SDK by itself on an excluded route.
  if (!initialized) {
    pendingIdentity = normalized;
    return;
  }
  applyIdentity(normalized);
});

/** Email signup form: flag test traffic first, then capture with first-touch attribution. */
export const captureSignupCompleted = createClientOnlyFn(
  (input: {
    method: string;
    email?: string | null;
    userId?: string | null;
    properties?: Record<string, string | number | boolean | null>;
  }) => {
    if (!initPostHog()) return;
    // Identify now (the Supabase user id is already known) so the first-touch
    // $set_once lands on the person even before the email is confirmed.
    if (input.userId) applyIdentity({ id: input.userId, email: input.email, provider: "email" });
    else applyTestAccountFlag(input.email);
    captureSignupCompletedNow(input.method, input.properties ?? {}, input.userId ?? null);
  },
);

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
