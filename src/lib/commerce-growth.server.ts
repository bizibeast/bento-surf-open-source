/* eslint-disable @typescript-eslint/no-explicit-any -- Growth rows are service-role only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  calculateCommerceCheckoutQuote,
  commerceCheckoutRequestsAdjustedPrice,
  normalizeCommerceDiscountCode,
  type CommerceCheckoutQuote,
} from "./commerce-growth";
import { creatorPaymentSupportsCheckoutAdjustments } from "./payment-providers";

type ProductForQuote = {
  id: string;
  creator_id: string;
  pricing_type: "free" | "one_time" | "subscription";
  price_amount: number;
  currency: string;
};

export type CommerceCheckoutGrowth = CommerceCheckoutQuote & {
  discountCode: string | null;
  bumpTitle: string | null;
  attribution: Record<string, string>;
};

function safeAttribution(input?: Record<string, string | undefined>) {
  const output: Record<string, string> = {};
  for (const key of ["referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
    const value = input?.[key]?.trim();
    if (value) output[key] = value.slice(0, key === "referrer" ? 2_048 : 200);
  }
  return output;
}

export async function resolveCommerceCheckoutGrowth(input: {
  product: ProductForQuote;
  provider: string;
  discountCode?: string;
  bumpProductId?: string;
  recordingAddonAmount?: number;
  attribution?: Record<string, string | undefined>;
}): Promise<CommerceCheckoutGrowth> {
  const db = supabaseAdmin as any;
  const code = normalizeCommerceDiscountCode(input.discountCode || "");
  const requestsAdjustment = commerceCheckoutRequestsAdjustedPrice({
    discountCode: code,
    bumpProductId: input.bumpProductId,
    recordingAddonAmount: input.recordingAddonAmount,
  });
  const requestsDiscountOrBump = Boolean(code || input.bumpProductId);
  const isFreeRecordingUpgrade =
    input.product.pricing_type === "free" &&
    !requestsDiscountOrBump &&
    Number(input.recordingAddonAmount || 0) > 0;
  if (requestsAdjustment && input.product.pricing_type !== "one_time" && !isFreeRecordingUpgrade) {
    throw new Error("Discount codes and paid add-ons currently require a one-time offer.");
  }
  if (requestsAdjustment && !creatorPaymentSupportsCheckoutAdjustments(input.provider)) {
    throw new Error(
      "This offer uses a discount or paid add-on that the connected payment gateway cannot price safely. Connect Stripe, PayPal, or Razorpay.",
    );
  }

  let discount: any = null;
  if (code) {
    const { data, error } = await db
      .from("commerce_discount_codes")
      .select("*")
      .eq("creator_id", input.product.creator_id)
      .eq("code", code)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const now = Date.now();
    if (
      !data ||
      (data.product_id && data.product_id !== input.product.id) ||
      (data.starts_at && new Date(data.starts_at).getTime() > now) ||
      (data.expires_at && new Date(data.expires_at).getTime() <= now) ||
      (data.discount_type === "fixed" && data.currency !== input.product.currency)
    ) {
      throw new Error("That discount code is not available for this offer.");
    }
    discount = data;
  }

  let bump: any = null;
  if (input.bumpProductId) {
    const { data: bumpRule, error: bumpRuleError } = await db
      .from("commerce_order_bumps")
      .select("id, bump_product_id")
      .eq("creator_id", input.product.creator_id)
      .eq("primary_product_id", input.product.id)
      .eq("bump_product_id", input.bumpProductId)
      .eq("is_active", true)
      .maybeSingle();
    if (bumpRuleError) throw new Error(bumpRuleError.message);
    if (!bumpRule) throw new Error("That order bump is no longer available.");
    const { data: bumpProduct, error: bumpError } = await db
      .from("commerce_products")
      .select(
        "id, creator_id, title, status, pricing_type, price_amount, currency, inventory_limit, sales_count",
      )
      .eq("id", bumpRule.bump_product_id)
      .eq("creator_id", input.product.creator_id)
      .eq("status", "published")
      .eq("pricing_type", "one_time")
      .maybeSingle();
    if (bumpError) throw new Error(bumpError.message);
    if (
      !bumpProduct ||
      bumpProduct.currency !== input.product.currency ||
      (bumpProduct.inventory_limit && bumpProduct.sales_count >= bumpProduct.inventory_limit)
    ) {
      throw new Error("That order bump is no longer available.");
    }
    bump = bumpProduct;
  }

  const quote = calculateCommerceCheckoutQuote({
    primaryAmount: input.product.price_amount,
    recordingAddonAmount: input.recordingAddonAmount,
    bumpAmount: bump?.price_amount || 0,
    bumpProductId: bump?.id || null,
    discount: discount
      ? {
          id: discount.id,
          type: discount.discount_type,
          value: discount.discount_value,
        }
      : null,
  });
  if (quote.grossAmount <= 0 && input.product.pricing_type !== "free") {
    throw new Error("This discount makes checkout free. Use a smaller discount.");
  }
  return {
    ...quote,
    discountCode: discount?.code || null,
    bumpTitle: bump?.title || null,
    attribution: safeAttribution(input.attribution),
  };
}

export async function persistCommerceCheckoutGrowth(input: {
  sessionId: string;
  buyerEmail: string;
  growth: CommerceCheckoutGrowth;
}) {
  const db = supabaseAdmin as any;
  const { data: updatedSession, error: updateError } = await db
    .from("commerce_payment_sessions")
    .update({
      subtotal_amount: input.growth.subtotalAmount,
      discount_amount: input.growth.discountAmount,
      discount_code_id: input.growth.discountCodeId,
      bump_product_id: input.growth.bumpProductId,
      bump_amount: input.growth.bumpAmount,
      attribution: input.growth.attribution,
    })
    .eq("id", input.sessionId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updatedSession) throw new Error("Checkout session is no longer pending.");
  if (input.growth.discountCodeId && input.growth.discountAmount > 0) {
    const { error } = await db.rpc("reserve_commerce_discount", {
      p_discount_code_id: input.growth.discountCodeId,
      p_payment_session_id: input.sessionId,
      p_buyer_email: input.buyerEmail,
      p_discount_amount: input.growth.discountAmount,
    });
    if (error) throw new Error(error.message);
  }
}

export async function failCommerceCheckoutSession(
  sessionId: string,
  cause: unknown,
  metadata?: Record<string, unknown>,
) {
  const db = supabaseAdmin as any;
  let mergedMetadata = metadata;
  if (metadata) {
    const { data: current, error: readError } = await db
      .from("commerce_payment_sessions")
      .select("metadata")
      .eq("id", sessionId)
      .maybeSingle();
    if (readError) {
      const original =
        cause instanceof Error ? cause.message : "The payment provider rejected checkout.";
      throw new Error(
        `${original} Bento could not preserve the failed checkout details: ${readError.message}`,
      );
    }
    mergedMetadata = { ...(current?.metadata || {}), ...metadata };
  }
  const { data: failedSession, error } = await db
    .from("commerce_payment_sessions")
    .update({ status: "failed", ...(mergedMetadata ? { metadata: mergedMetadata } : {}) })
    .eq("id", sessionId)
    .in("status", ["pending", "approved"])
    .select("id")
    .maybeSingle();
  if (error) {
    const original =
      cause instanceof Error ? cause.message : "The payment provider rejected checkout.";
    throw new Error(
      `${original} Bento could not close the failed checkout safely: ${error.message}`,
    );
  }
  if (!failedSession) {
    const original =
      cause instanceof Error ? cause.message : "The payment provider rejected checkout.";
    const { data: currentSession, error: currentSessionError } = await db
      .from("commerce_payment_sessions")
      .select("status")
      .eq("id", sessionId)
      .maybeSingle();
    if (currentSessionError) {
      throw new Error(
        `${original} Bento could not verify the checkout's final state: ${currentSessionError.message}`,
      );
    }
    if (currentSession?.status === "paid") {
      console.info(
        `[commerce] checkout ${sessionId} completed while a provider error was being handled`,
      );
      return;
    }
    throw new Error(`${original} Bento checkout had already left its payable state.`);
  }
}

export function commerceCheckoutGrowthMetadata(growth: CommerceCheckoutGrowth) {
  return {
    bento_discount_code_id: growth.discountCodeId,
    bento_discount_code: growth.discountCode,
    bento_discount_amount: growth.discountAmount,
    bento_bump_product_id: growth.bumpProductId,
    bento_bump_amount: growth.bumpAmount,
    bento_subtotal_amount: growth.subtotalAmount,
    ...growth.attribution,
  };
}
