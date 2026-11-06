import { readCheckoutReturn } from "./checkout-return";

/**
 * Our side of a hosted checkout (Dodo). We cannot see the hosted page, so we remember that a
 * checkout was started and report `checkout_page_left` when the buyer comes back to our app
 * without a checkout-return marker. Each attempt is reported at most once: the pending record is
 * removed from sessionStorage before anything is sent.
 */
export const PENDING_CHECKOUT_KEY = "bento:checkout-pending:v1";
/** A tab that was hidden and becomes visible again this long after checkout started counts as left. */
export const CHECKOUT_VISIBILITY_TIMEOUT_MS = 60_000;
/** Records older than this are stale (a forgotten tab), not a meaningful abandonment signal. */
export const CHECKOUT_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PendingCheckout = {
  startedAt: number;
  plan: string;
  trial: boolean;
  surface: string;
};

export type CheckoutLeftReason = "reload_or_return" | "back_navigation" | "visibility_timeout";

export type CheckoutLeftProperties = {
  plan: string;
  trial: boolean;
  elapsed_seconds: number;
  surface: string;
  reason: CheckoutLeftReason;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function parsePending(raw: string | null): PendingCheckout | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingCheckout>;
    if (
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      typeof value.plan !== "string" ||
      typeof value.trial !== "boolean"
    )
      return null;
    return {
      startedAt: value.startedAt,
      plan: value.plan,
      trial: value.trial,
      surface: typeof value.surface === "string" ? value.surface : "unknown",
    };
  } catch {
    return null;
  }
}

export function readPendingCheckout(): PendingCheckout | null {
  return parsePending(storage()?.getItem(PENDING_CHECKOUT_KEY) ?? null);
}

/** Remember a started checkout. Call right before navigating to the hosted page. */
export function rememberCheckoutStarted(
  input: { plan: string; trial: boolean; surface: string },
  now = Date.now(),
) {
  try {
    storage()?.setItem(
      PENDING_CHECKOUT_KEY,
      JSON.stringify({ ...input, startedAt: now } satisfies PendingCheckout),
    );
  } catch {
    /* Private mode: no abandonment signal, checkout itself is unaffected. */
  }
}

/** Read and remove the pending checkout in one step, so it can be reported only once. */
function takePendingCheckout(): PendingCheckout | null {
  const store = storage();
  if (!store) return null;
  const pending = parsePending(store.getItem(PENDING_CHECKOUT_KEY));
  try {
    store.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    return null;
  }
  return pending;
}

export function checkoutLeftProperties(
  pending: PendingCheckout,
  reason: CheckoutLeftReason,
  now: number,
): CheckoutLeftProperties {
  return {
    plan: pending.plan,
    trial: pending.trial,
    elapsed_seconds: Math.max(0, Math.round((now - pending.startedAt) / 1000)),
    surface: pending.surface,
    reason,
  };
}

/**
 * Decide what a return to our app means for a pending checkout.
 * - "returned": the URL carries Dodo's return marker, so the normal return events handle it.
 * - "waiting": visibility return before the timeout; keep the record.
 * - "left": report `checkout_page_left` (the record is already removed).
 */
export function resolvePendingCheckout(
  reason: CheckoutLeftReason,
  options: { search?: string; now?: number } = {},
):
  | { kind: "none" }
  | { kind: "returned" }
  | { kind: "waiting" }
  | { kind: "left"; properties: CheckoutLeftProperties } {
  const pending = readPendingCheckout();
  if (!pending) return { kind: "none" };
  const now = options.now ?? Date.now();
  const search = options.search ?? (typeof window === "undefined" ? "" : window.location.search);
  const age = now - pending.startedAt;

  if (readCheckoutReturn(search).outcome !== "none") {
    takePendingCheckout();
    return { kind: "returned" };
  }
  if (age > CHECKOUT_PENDING_MAX_AGE_MS) {
    takePendingCheckout();
    return { kind: "none" };
  }
  if (reason === "visibility_timeout" && age < CHECKOUT_VISIBILITY_TIMEOUT_MS)
    return { kind: "waiting" };

  const taken = takePendingCheckout();
  if (!taken) return { kind: "none" };
  return { kind: "left", properties: checkoutLeftProperties(taken, reason, now) };
}

function reportLeft(properties: CheckoutLeftProperties) {
  void import("./posthog")
    .then(({ captureProductEvent }) => captureProductEvent("checkout_page_left", properties))
    .catch((error) => console.error("[Analytics] Checkout exit could not be reported.", error));
}

/** Check once, synchronously deciding whether this load is a return or an exit. */
export function checkPendingCheckout(
  reason: CheckoutLeftReason,
  options: { search?: string; now?: number } = {},
) {
  const result = resolvePendingCheckout(reason, options);
  if (result.kind === "left") reportLeft(result.properties);
  return result.kind;
}

/**
 * Watches for the buyer returning to our app. Returns a cleanup function.
 * The first check runs synchronously (reload, or navigating back to a fresh load), before any
 * component strips Dodo's return parameters from the URL.
 */
export function watchCheckoutExit(): () => void {
  if (typeof window === "undefined") return () => undefined;
  checkPendingCheckout("reload_or_return");
  const onPageShow = (event: PageTransitionEvent) => {
    // Back/forward cache restore: the page comes back with its JavaScript state, not as a new load.
    if (event.persisted) checkPendingCheckout("back_navigation");
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") checkPendingCheckout("visibility_timeout");
  };
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Start tracking a checkout and make sure this session is replayed. */
export function beginCheckoutTracking(input: { plan: string; trial: boolean; surface: string }) {
  rememberCheckoutStarted(input);
  forceCheckoutReplay();
}

/** The buyer reached the trial or checkout step: record this session even if it was not sampled. */
export function forceCheckoutReplay() {
  void import("./posthog")
    .then(({ setCheckoutReplayForced }) => setCheckoutReplayForced())
    .catch((error) => console.error("[Analytics] Checkout replay could not start.", error));
}

/** Record onboarding using the existing replay controls and masking. */
export function forceOnboardingReplay() {
  void import("./posthog")
    .then(({ setCheckoutReplayForced }) => setCheckoutReplayForced())
    .catch((error) => console.error("[Analytics] Onboarding replay could not start.", error));
}
