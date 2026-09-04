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

export function clearCheckoutRecovery(storage: StorageLike, productId: string) {
  try {
    storage.removeItem(storageKey(productId));
  } catch {
    // A failed cleanup is harmless because drafts expire after two hours.
  }
}
