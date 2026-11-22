import { beforeEach, expect, it, vi } from "vitest";
import {
  CHECKOUT_RECOVERY_KEY,
  CHECKOUT_RECOVERY_WINDOW_MS,
  checkoutRecoveryMinutes,
  dismissCheckoutRecovery,
  readRecoverableCheckout,
  rememberCheckoutForRecovery,
} from "./checkout-recovery";

const input = {
  plan: "creator",
  period: "yearly",
  trial: true,
  surface: "upgrade_dialog",
} as const;
const now = 2_000_000;
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});
it("accepts 29:59 and rejects 30:01 and future timestamps", () => {
  rememberCheckoutForRecovery(input, now - CHECKOUT_RECOVERY_WINDOW_MS + 1000);
  expect(readRecoverableCheckout({ now, hasAccess: false })).toMatchObject(input);
  rememberCheckoutForRecovery(input, now - CHECKOUT_RECOVERY_WINDOW_MS - 1000);
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
  rememberCheckoutForRecovery(input, now + 1);
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
});
it("does not recover a Creator Plus checkout into a different monthly offer", () => {
  const prior = { ...input, plan: "creator_plus", period: "monthly", startedAt: now } as const;
  localStorage.setItem(CHECKOUT_RECOVERY_KEY, JSON.stringify(prior));
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
  rememberCheckoutForRecovery(prior, now);
  expect(readRecoverableCheckout({ now, hasAccess: false })).toMatchObject(prior);
});
it("dismisses and clears records with access", () => {
  rememberCheckoutForRecovery(input, now);
  dismissCheckoutRecovery(now);
  expect(JSON.parse(localStorage.getItem(CHECKOUT_RECOVERY_KEY)!)).toHaveProperty(
    "dismissedAt",
    now,
  );
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
  rememberCheckoutForRecovery(input, now);
  expect(readRecoverableCheckout({ now, hasAccess: true })).toBeNull();
  expect(localStorage.getItem(CHECKOUT_RECOVERY_KEY)).toBeNull();
});
it.each([
  "{",
  "null",
  JSON.stringify({ ...input, plan: "free", startedAt: now }),
  JSON.stringify({ ...input, period: "weekly", startedAt: now }),
])("rejects invalid storage %s", (raw) => {
  localStorage.setItem(CHECKOUT_RECOVERY_KEY, raw);
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
});
it("tolerates storage errors", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("private");
  });
  expect(() => rememberCheckoutForRecovery(input, now)).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("private");
  });
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
  expect(() => dismissCheckoutRecovery(now)).not.toThrow();
});
it.each(["active", "processing"])("clears %s returns", (status) => {
  rememberCheckoutForRecovery(input, now);
  window.history.replaceState({}, "", `/?checkout=1&status=${status}`);
  expect(readRecoverableCheckout({ now, hasAccess: false })).toBeNull();
  expect(localStorage.getItem(CHECKOUT_RECOVERY_KEY)).toBeNull();
});
it("keeps failed returns and reports whole minutes with a minimum of one", () => {
  rememberCheckoutForRecovery(input, now);
  window.history.replaceState({}, "", "/?checkout=1&status=failed");
  const record = readRecoverableCheckout({ now, hasAccess: false })!;
  expect(record).not.toBeNull();
  expect(checkoutRecoveryMinutes(record, now)).toBe(1);
  expect(checkoutRecoveryMinutes(record, now + 179_999)).toBe(2);
});
