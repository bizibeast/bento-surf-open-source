import type { CheckoutSessionCreateParams } from "dodopayments/resources/checkout-sessions";
import { z } from "zod";
import { dodo } from "@/integrations/dodo/client.server";
import { TRIAL_DAYS, PLAN_PRICING, newPlanPrice, type PaidPlanId } from "./plans";

function assertProductPrice(product: unknown, amount: number, interval: "Month" | "Year") {
  z.object({
    price: z.object({
      type: z.literal("recurring_price"),
      currency: z.literal("USD"),
      price: z.literal(amount * 100),
      payment_frequency_count: z.literal(1),
      payment_frequency_interval: z.literal(interval),
      subscription_period_count: z.literal(1),
      subscription_period_interval: z.literal(interval),
      discount: z.literal(0),
    }),
  }).parse(product);
}

export async function verifyFullyManagedProduct(productId: string) {
  try {
    const product = await dodo.products.retrieve(productId);
    if (product.product_id !== productId || !product.is_recurring)
      throw new Error("Product mismatch.");
    assertProductPrice(product, newPlanPrice("creator_plus", "monthly").amount, "Month");
  } catch {
    throw new Error(
      "Fully Managed checkout could not be verified. Contact your instance administrator.",
    );
  }
}

export async function verifyYearlyProduct(productId: string, plan: PaidPlanId) {
  try {
    const product = await dodo.products.retrieve(productId);
    if (product.product_id !== productId || !product.is_recurring)
      throw new Error("Product mismatch.");
    assertProductPrice(product, PLAN_PRICING[plan].yearly.amount, "Year");
  } catch {
    console.error("Dodo yearly product verification failed.");
    throw new Error(
      "Yearly checkout could not be verified. Please try again or contact your instance administrator.",
    );
  }
}

// These fields are documented by Dodo but are newer than the installed SDK's
// types. Validate the provider JSON rather than trusting a type assertion.
const freeCardTrialProduct = z.object({
  product_id: z.string(),
  is_recurring: z.literal(true),
  price: z.object({
    type: z.literal("recurring_price"),
    trial_amount: z.null().optional(),
    // Dodo documents omitted flags as false; explicit unknown values fail closed.
    trial_payment_method_optional: z.literal(false).optional(),
    zero_amount_payment_method_optional: z.literal(false).optional(),
  }),
});
const freeTrialPreview = z.object({
  current_breakup: z.object({ total_amount: z.literal(0) }),
  trial_period_days: z.literal(TRIAL_DAYS),
  trial_amount: z.null().optional(),
});

export async function verifyFreeTrialCheckout(
  productId: string,
  checkout: CheckoutSessionCreateParams,
  yearlyPlan?: PaidPlanId,
  fullyManaged = false,
) {
  try {
    const productJson = await dodo.products.retrieve(productId);
    const product = freeCardTrialProduct.parse(productJson);
    if (product.product_id !== productId) throw new Error("Trial product mismatch.");
    if (yearlyPlan) assertProductPrice(productJson, PLAN_PRICING[yearlyPlan].yearly.amount, "Year");
    if (fullyManaged)
      assertProductPrice(productJson, newPlanPrice("creator_plus", "monthly").amount, "Month");
    freeTrialPreview.parse(await dodo.checkoutSessions.preview(checkout));
    const environment =
      process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";
    return `free-card-v2:${TRIAL_DAYS}:${environment}:${productId}`;
  } catch {
    // No provider payload, customer data or validation details in logs/errors.
    console.error("Dodo free card-required trial verification failed.");
    throw new Error(
      "Your trial checkout could not be verified. Please try again or contact your instance administrator.",
    );
  }
}
