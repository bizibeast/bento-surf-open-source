/**
 * Dodo appends `status` (plus `payment_id` or `subscription_id`) to our
 * checkout return URL. The redirect is only a UI hint: access is granted by
 * verified webhooks. It must never be read as success unless Dodo says so.
 */
export type CheckoutReturnOutcome = "none" | "succeeded" | "failed" | "pending";

const SUCCEEDED = new Set(["active", "succeeded"]);
const FAILED = new Set(["failed", "cancelled", "canceled", "expired", "declined"]);
const RETURN_PARAMS = [
  "checkout",
  "trial",
  "status",
  "payment_id",
  "subscription_id",
  "email",
  "upgraded",
];

export function readCheckoutReturn(search: string | URLSearchParams): {
  outcome: CheckoutReturnOutcome;
  status: string | null;
  trial: boolean;
} {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const trial = params.get("trial") !== "0";
  const raw = params.get("status")?.trim().toLowerCase() || null;
  const fromCheckout =
    params.has("checkout") ||
    params.has("upgraded") ||
    params.has("payment_id") ||
    params.has("subscription_id");
  if (!raw) return { outcome: fromCheckout ? "pending" : "none", status: null, trial };
  if (!fromCheckout) return { outcome: "none", status: raw, trial };
  if (SUCCEEDED.has(raw)) return { outcome: "succeeded", status: raw, trial };
  if (FAILED.has(raw)) return { outcome: "failed", status: raw, trial };
  // processing, requires_* and unknown values settle later via the webhook.
  return { outcome: "pending", status: raw, trial };
}

export function checkoutFailureMessage(status: string | null, trial: boolean) {
  if (status === "expired")
    return "Your checkout expired before payment, so nothing was charged. Please start checkout again.";
  return trial
    ? "Your card didn't go through, so your trial hasn't started. Nothing was charged. Please try another card."
    : "Your card didn't go through, so your plan hasn't started. Nothing was charged. Please try another card.";
}

/** Remove provider return parameters so a refresh does not replay the notice. */
export function withoutCheckoutReturnParams(href: string) {
  const url = new URL(href);
  for (const key of RETURN_PARAMS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
