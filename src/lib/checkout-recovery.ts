import { PAID_PLAN_IDS, type PaidPlanId, type BillingPeriod } from "./plans";
import { readCheckoutReturn } from "./checkout-return";

export const CHECKOUT_RECOVERY_KEY = "bento:checkout-recovery:v1";
export const CHECKOUT_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
export type CheckoutRecovery = {
  plan: PaidPlanId;
  period: BillingPeriod;
  trial: boolean;
  surface: "onboarding_trial_step" | "upgrade_dialog";
  startedAt: number;
  dismissedAt?: number;
};

export function clearCheckoutRecovery(): void;
export function clearCheckoutRecovery(storage: StorageLike, productId: string): void;
export function clearCheckoutRecovery(storage?: StorageLike, productId?: string) {
  if (storage && productId !== undefined) {
    clearProductCheckoutRecovery(storage, productId);
    return;
  }
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(CHECKOUT_RECOVERY_KEY);
  } catch {
    /* Storage may be unavailable. */
  }
}

export function rememberCheckoutForRecovery(
  input: Omit<CheckoutRecovery, "startedAt" | "dismissedAt">,
  now = Date.now(),
) {
  try {
    window.localStorage.setItem(
      CHECKOUT_RECOVERY_KEY,
      JSON.stringify({ ...input, startedAt: now }),
    );
  } catch {
    /* Checkout can proceed without storage. */
  }
}

export function clearCheckoutRecoveryOnReturn() {
  if (typeof window === "undefined") return;
  const { outcome } = readCheckoutReturn(window.location.search);
  if (outcome === "succeeded" || outcome === "pending") clearCheckoutRecovery();
}

export function readRecoverableCheckout({
  now = Date.now(),
  hasAccess,
}: {
  now?: number;
  hasAccess: boolean;
}): CheckoutRecovery | null {
  if (hasAccess) {
    clearCheckoutRecovery();
    return null;
  }
  clearCheckoutRecoveryOnReturn();
  try {
    const value = JSON.parse(window.localStorage.getItem(CHECKOUT_RECOVERY_KEY) || "null");
    if (
      !value ||
      !PAID_PLAN_IDS.includes(value.plan) ||
      !["monthly", "yearly"].includes(value.period) ||
      typeof value.trial !== "boolean" ||
      !["onboarding_trial_step", "upgrade_dialog"].includes(value.surface) ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      value.startedAt > now ||
      now - value.startedAt > CHECKOUT_RECOVERY_WINDOW_MS ||
      value.dismissedAt !== undefined
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function dismissCheckoutRecovery(now = Date.now()) {
  const record = readRecoverableCheckout({ now, hasAccess: false });
  if (!record) return;
  try {
    window.localStorage.setItem(
      CHECKOUT_RECOVERY_KEY,
      JSON.stringify({ ...record, dismissedAt: now }),
    );
  } catch {
    /* Dismissal still hides the mounted banner. */
  }
}

export function checkoutRecoveryMinutes(record: CheckoutRecovery, now: number) {
  return Math.max(1, Math.floor((now - record.startedAt) / 60_000));
}

export function checkoutRecoveryProperties(
  record: CheckoutRecovery,
  surface: "onboarding" | "upgrade_dialog",
) {
  return {
    plan: record.plan,
    billing_interval: record.period,
    trial: record.trial,
    surface,
    original_surface: record.surface,
    minutes_since_checkout: checkoutRecoveryMinutes(record, Date.now()),
  };
}

const CHECKOUT_RECOVERY_VERSION = 1;
const CHECKOUT_RECOVERY_TTL_MS = 2 * 60 * 60 * 1_000;
const KEY_PREFIX = "bento:checkout-recovery:";

export type CheckoutRecoveryDraft = {
  productId: string;
  email: string;
  name: string;
  recordingAddon: boolean;
  updatedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoredCheckoutRecoveryDraft = CheckoutRecoveryDraft & {
  version: typeof CHECKOUT_RECOVERY_VERSION;
};

function storageKey(productId: string) {
  return `${KEY_PREFIX}${productId}`;
}

function parseStoredDraft(
  value: string,
  productId: string,
  now: number,
): StoredCheckoutRecoveryDraft | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredCheckoutRecoveryDraft>;
    if (
      parsed.version !== CHECKOUT_RECOVERY_VERSION ||
      parsed.productId !== productId ||
      typeof parsed.email !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.recordingAddon !== "boolean" ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) ||
      parsed.updatedAt > now + 60_000 ||
      now - parsed.updatedAt > CHECKOUT_RECOVERY_TTL_MS
    ) {
      return null;
    }
    return {
      version: CHECKOUT_RECOVERY_VERSION,
      productId,
      email: parsed.email.slice(0, 254),
      name: parsed.name.slice(0, 120),
      recordingAddon: parsed.recordingAddon,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function readCheckoutRecovery(
  storage: StorageLike,
  productId: string,
  now = Date.now(),
): CheckoutRecoveryDraft | null {
  const key = storageKey(productId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  const parsed = parseStoredDraft(raw, productId, now);
  if (!parsed) {
    try {
      storage.removeItem(key);
    } catch {
      // Recovery is an enhancement and must never block checkout.
    }
    return null;
  }
  const { version: _version, ...draft } = parsed;
  return draft;
}

export function writeCheckoutRecovery(
  storage: StorageLike,
  draft: Omit<CheckoutRecoveryDraft, "updatedAt">,
  now = Date.now(),
) {
  const value: StoredCheckoutRecoveryDraft = {
    version: CHECKOUT_RECOVERY_VERSION,
    productId: draft.productId,
    email: draft.email.slice(0, 254),
    name: draft.name.slice(0, 120),
    recordingAddon: draft.recordingAddon,
    updatedAt: now,
  };
  try {
    storage.setItem(storageKey(draft.productId), JSON.stringify(value));
  } catch {
    // Browser privacy or quota policies must not prevent payment.
  }
}

function clearProductCheckoutRecovery(storage: StorageLike, productId: string) {
  try {
    storage.removeItem(storageKey(productId));
  } catch {
    // A failed cleanup is harmless because drafts expire after two hours.
  }
}
