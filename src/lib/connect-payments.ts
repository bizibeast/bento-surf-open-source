import { createCheckout, getCheckoutOffer, getMyBillingOverview } from "./billing.functions";
import { captureProductEvent } from "./posthog";
import { getCreatorPaymentSettings } from "./payment-connections.functions";
import { BASE_MARKETING_CONTACTS, type PlanId } from "./plans";
import { safeNavigationHref } from "./safe-url";

export const STORE_PAYMENTS_CHECKOUT = {
  plan: "store" as const,
  period: "monthly" as const,
  returnTo: "payments" as const,
  storageUnits: 0,
  contactTier: BASE_MARKETING_CONTACTS,
};

export type ConnectPaymentsOutcome = "trial_checkout" | "paid_checkout" | "connect";

export function connectPaymentsOutcome(input: {
  locked: boolean;
  trialEligible: boolean;
}): ConnectPaymentsOutcome {
  if (!input.locked) return "connect";
  return input.trialEligible ? "trial_checkout" : "paid_checkout";
}

export async function requestConnectPayments(input: { plan: PlanId; locked: boolean }) {
  if (!input.locked) {
    captureProductEvent("connect_payments_clicked", { plan: input.plan, outcome: "connect" });
    return { outcome: "connect" as const, url: null };
  }
  const offer = await getCheckoutOffer();
  const outcome = connectPaymentsOutcome({
    locked: true,
    trialEligible: offer.trialEligible,
  });
  captureProductEvent("connect_payments_clicked", { plan: input.plan, outcome });
  const { url } = await createCheckout({ data: STORE_PAYMENTS_CHECKOUT });
  const destination = safeNavigationHref(url);
  if (!destination) throw new Error("Checkout returned an invalid destination.");
  return { outcome, url: destination };
}

export async function requestCurrentConnectPayments() {
  const [settings, billing] = await Promise.all([
    getCreatorPaymentSettings(),
    getMyBillingOverview(),
  ]);
  return requestConnectPayments({ plan: billing.plan, locked: settings.locked });
}

export async function followConnectPayments(input: {
  plan: PlanId;
  locked: boolean;
  connect: () => void | Promise<void>;
}) {
  const result = await requestConnectPayments(input);
  if (result.url) {
    window.location.assign(result.url);
    return result;
  }
  await input.connect();
  return result;
}

export async function followCurrentConnectPayments(connect: () => void | Promise<void>) {
  const [settings, billing] = await Promise.all([
    getCreatorPaymentSettings(),
    getMyBillingOverview(),
  ]);
  return followConnectPayments({ plan: billing.plan, locked: settings.locked, connect });
}
