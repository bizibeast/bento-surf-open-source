import type { CheckoutSessionCreateParams } from "dodopayments/resources/checkout-sessions";
import { z } from "zod";
import { dodo } from "@/integrations/dodo/client.server";
import { TRIAL_DAYS, PLAN_PRICING, type PaidPlanId } from "./plans";

function assertYearlyPrice(product: unknown, plan: PaidPlanId) {
  z.object({
    price: z.object({
      type: z.literal("recurring_price"),
      currency: z.literal("USD"),
      price: z.literal(PLAN_PRICING[plan].yearly.amount * 100),
      payment_frequency_count: z.literal(1),
      payment_frequency_interval: z.literal("Year"),
      subscription_period_count: z.literal(1),
      subscription_period_interval: z.literal("Year"),
      discount: z.literal(0),
    }),
  }).parse(product);
}

export async function verifyYearlyProduct(productId: string, plan: PaidPlanId) {
  try {
    const product = await dodo.products.retrieve(productId);
    if (product.product_id !== productId || !product.is_recurring)
      throw new Error("Product mismatch.");
    assertYearlyPrice(product, plan);
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
) {
  try {
    const productJson = await dodo.products.retrieve(productId);
    const product = freeCardTrialProduct.parse(productJson);
    if (product.product_id !== productId) throw new Error("Trial product mismatch.");
    if (yearlyPlan) assertYearlyPrice(productJson, yearlyPlan);
    freeTrialPreview.parse(await dodo.checkoutSessions.preview(checkout));
    const environment =
      process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";
    return `free-card-v2:${TRIAL_DAYS}:${environment}:${productId}`;
  } catch {
    // No provider payload, customer data or validation details in logs/errors.
    console.error("Dodo free card-required trial verification failed.");
    throw new Error(
      "Your free trial checkout could not be verified. Please try again or contact your instance administrator.",
    );
  }
}
