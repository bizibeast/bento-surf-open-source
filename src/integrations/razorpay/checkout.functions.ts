/* eslint-disable @typescript-eslint/no-explicit-any -- Razorpay payloads are verified before fulfillment. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  calculateCommerceAmounts,
  isHostedAccessKind,
  type CommerceBuyerAnswer,
  type CommerceProductKind,
} from "@/lib/commerce";
import {
  commerceOrderMetadata,
  finalizeCommerceFulfillment,
} from "@/lib/commerce-fulfillment.server";
import { enforceRequestRateLimit } from "@/lib/request-security.server";
import { decryptServerSecret, encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  getRazorpayPaymentAccount,
  getRazorpayPaymentAccountById,
  razorpayCredentialsForAccount,
  razorpayEnvironment,
  razorpayRequest,
  verifyRazorpayPaymentSignature,
  type RazorpayPaymentAccount,
} from "./client.server";
import {
  commerceCheckoutGrowthMetadata,
  failCommerceCheckoutSession,
  persistCommerceCheckoutGrowth,
  type CommerceCheckoutGrowth,
} from "@/lib/commerce-growth.server";
import {
  configuredAppOrigin,
  publicProductSuccessPath,
  publicProductUrl,
} from "@/lib/application-urls";

type CheckoutProduct = {
  id: string;
  creator_id: string;
  slug: string;
  public_slug: string;
  creator_username: string;
  kind: string;
  title: string;
  description: string;
  pricing_type: "one_time" | "subscription";
  price_amount: number;
  currency: string;
  billing_interval: "day" | "week" | "month" | "year" | null;
};

export type RazorpayPayment = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
  order_id: string | null;
  email?: string | null;
  fee?: number | null;
  tax?: number | null;
  method?: string | null;
  amount_refunded?: number | null;
};

const uuidSchema = z.string().uuid();
const paymentIdSchema = z
  .string()
  .regex(/^pay_[A-Za-z0-9]+$/)
  .max(128);
const orderIdSchema = z
  .string()
  .regex(/^order_[A-Za-z0-9]+$/)
  .max(128);
const signatureSchema = z.string().regex(/^[a-f0-9]{64}$/i);

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function randomAccessToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function finalizeRazorpayPayment(input: {
  account: RazorpayPaymentAccount;
  session: any;
  payment: RazorpayPayment;
}) {
  const { account, session, payment } = input;
  if (session.provider !== "razorpay" || session.connection_id !== account.id) {
    throw new Error("Razorpay payment does not match this Bento connection.");
  }
  if (["failed", "expired", "canceled"].includes(session.status)) {
    throw new Error("This checkout session is no longer valid.");
  }
  if (!session.provider_checkout_id || payment.order_id !== session.provider_checkout_id) {
    throw new Error("Razorpay Order does not match this Bento checkout.");
  }
  if (!payment.captured || payment.status !== "captured") {
    throw new Error("The Razorpay payment has not been captured yet.");
  }
  if (
    Number(payment.amount) !== Number(session.gross_amount) ||
    String(payment.currency).toLowerCase() !== String(session.currency).toLowerCase()
  ) {
    throw new Error("Razorpay payment amount does not match this Bento checkout.");
  }

  const processorFee = Math.max(0, Number(payment.fee || 0));
  const db = supabaseAdmin as any;
  const { data: fulfilled, error } = await db.rpc("fulfill_provider_commerce_order", {
    p_product_id: session.product_id,
    p_buyer_email: session.buyer_email,
    p_buyer_name: session.buyer_name || "",
    p_provider: "razorpay",
    p_provider_account_id: account.provider_account_id,
    p_provider_checkout_id: session.provider_checkout_id,
    p_provider_payment_id: payment.id,
    p_provider_subscription_id: "",
    p_gross_amount: session.gross_amount,
    p_platform_fee_bps: 0,
    p_platform_fee_amount: 0,
    p_processor_fee_amount: processorFee,
    p_tax_amount: 0,
    p_net_amount: Math.max(0, Number(session.gross_amount) - processorFee),
    p_currency: session.currency,
    p_metadata: commerceOrderMetadata(session, {
      bento_session_id: session.id,
      razorpay_order_id: session.provider_checkout_id,
      razorpay_payment_id: payment.id,
      razorpay_method: payment.method || null,
      razorpay_fee_tax: Math.max(0, Number(payment.tax || 0)),
      recording_addon_selected: Boolean(session.recording_addon_selected),
      recording_addon_amount: Number(session.recording_addon_amount || 0),
    }),
    p_access_token_hash: session.access_token_hash,
  });
  if (error || !fulfilled?.order_id) {
    throw new Error(error?.message || "Razorpay order could not be fulfilled.");
  }
  const accessToken = session.metadata?.access_token_ciphertext
    ? await decryptServerSecret(session.metadata.access_token_ciphertext)
    : null;
  await finalizeCommerceFulfillment({
    session,
    orderId: fulfilled.order_id,
    providerCheckoutId: session.provider_checkout_id,
    metadata: { razorpay_payment_id: payment.id },
  });
  return { orderId: String(fulfilled.order_id), accessToken };
}

export async function createRazorpayCommerceCheckout(input: {
  product: CheckoutProduct;
  email: string;
  name?: string;
  recordingAddon?: { selected: boolean; amount: number };
  growth: CommerceCheckoutGrowth;
  buyerAnswers?: CommerceBuyerAnswer[];
}) {
  if (input.product.pricing_type === "subscription") {
    throw new Error(
      "Razorpay recurring subscriptions are not available in Bento yet. Choose Stripe, Polar, or Dodo Payments for this product.",
    );
  }
  const account = await getRazorpayPaymentAccount(input.product.creator_id);
  if (!account) throw new Error("This creator has not connected Razorpay yet.");
  if (!account.charges_enabled || !account.payouts_enabled || !account.webhook_secret_ciphertext) {
    throw new Error(
      "This creator must finish the Razorpay webhook setup before accepting payments.",
    );
  }

  const credentials = await razorpayCredentialsForAccount(account);
  const amounts = calculateCommerceAmounts(input.product.price_amount, 0);
  const accessToken = isHostedAccessKind(input.product.kind as CommerceProductKind)
    ? randomAccessToken()
    : null;
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000);
  const db = supabaseAdmin as any;
  const { error: sessionError } = await db.from("commerce_payment_sessions").insert({
    id: sessionId,
    product_id: input.product.id,
    creator_id: input.product.creator_id,
    connection_id: account.id,
    provider: "razorpay",
    buyer_email: input.email.toLowerCase(),
    buyer_name: input.name || null,
    gross_amount: amounts.grossAmount,
    platform_fee_bps: 0,
    platform_fee_amount: 0,
    currency: input.product.currency.toLowerCase(),
    access_token_hash: accessToken ? await sha256(accessToken) : null,
    recording_addon_selected: Boolean(input.recordingAddon?.selected),
    recording_addon_amount: input.recordingAddon?.amount || 0,
    expires_at: expiresAt.toISOString(),
    metadata: {
      product_slug: input.product.slug,
      product_public_slug: input.product.public_slug,
      creator_username: input.product.creator_username,
      access_token_ciphertext: accessToken ? await encryptServerSecret(accessToken) : null,
      recording_addon_selected: Boolean(input.recordingAddon?.selected),
      recording_addon_amount: input.recordingAddon?.amount || 0,
      ...(input.buyerAnswers?.length ? { buyer_answers: input.buyerAnswers } : {}),
    },
  });
  if (sessionError) throw new Error(sessionError.message);
  try {
    await persistCommerceCheckoutGrowth({
      sessionId,
      buyerEmail: input.email,
      growth: input.growth,
    });
  } catch (error) {
    await failCommerceCheckoutSession(sessionId, error);
    throw error;
  }

  try {
    const order = await razorpayRequest<{
      id: string;
      amount: number;
      currency: string;
      status: string;
    }>(credentials, "/v1/orders", {
      method: "POST",
      body: {
        amount: amounts.grossAmount,
        currency: input.product.currency.toUpperCase(),
        receipt: `bento_${sessionId.replaceAll("-", "").slice(0, 32)}`,
        notes: {
          bento_session_id: sessionId,
          bento_product_id: input.product.id,
          bento_creator_id: input.product.creator_id,
          ...Object.fromEntries(
            Object.entries(commerceCheckoutGrowthMetadata(input.growth)).map(([key, value]) => [
              key,
              value === null ? "" : String(value),
            ]),
          ),
        },
      },
    });
    if (!order.id || order.status !== "created") {
      throw new Error("Razorpay did not create a payable Order.");
    }
    const { error: updateError } = await db
      .from("commerce_payment_sessions")
      .update({ provider_checkout_id: order.id })
      .eq("id", sessionId)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);
    return {
      url: `${appUrl()}/payments/razorpay/${sessionId}`,
      test: razorpayEnvironment(credentials.keyId) === "sandbox",
    };
  } catch (error) {
    await failCommerceCheckoutSession(sessionId, error);
    throw error;
  }
}

export const getRazorpayCheckout = createServerFn({ method: "GET" })
  .validator((input) => z.object({ sessionId: uuidSchema }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("CHECKOUT_RATE_LIMITER", "razorpay-checkout-view");
    const db = supabaseAdmin as any;
    const { data: session, error } = await db
      .from("commerce_payment_sessions")
      .select("*")
      .eq("id", data.sessionId)
      .eq("provider", "razorpay")
      .maybeSingle();
    if (error || !session) throw new Error(error?.message || "Checkout was not found.");
    if (session.status !== "pending" || new Date(session.expires_at) <= new Date()) {
      throw new Error("This Razorpay checkout has expired or is already complete.");
    }
    const [account, productResult, creatorResult] = await Promise.all([
      getRazorpayPaymentAccountById(session.connection_id),
      db
        .from("commerce_products")
        .select("title, description, slug")
        .eq("id", session.product_id)
        .eq("creator_id", session.creator_id)
        .maybeSingle(),
      db
        .from("profiles")
        .select("display_name, username")
        .eq("id", session.creator_id)
        .maybeSingle(),
    ]);
    if (!account || !account.charges_enabled || !account.webhook_secret_ciphertext) {
      throw new Error("This creator's Razorpay connection is not ready.");
    }
    const product = productResult.data;
    // The product was verified and inventory was reserved when this payment
    // session was created. A creator archiving it afterwards must not strand a
    // buyer who is already inside Razorpay's short-lived checkout.
    if (productResult.error || !product) {
      throw new Error("This product is not available.");
    }
    if (!session.provider_checkout_id) throw new Error("Razorpay Order is missing.");
    return {
      sessionId: session.id as string,
      orderId: session.provider_checkout_id as string,
      keyId: account.provider_account_id,
      amount: Number(session.gross_amount),
      currency: String(session.currency).toUpperCase(),
      buyerEmail: String(session.buyer_email),
      buyerName: String(session.buyer_name || ""),
      productTitle: String(product.title),
      productDescription: String(product.description || "").slice(0, 255),
      productSlug: String(product.slug),
      cancelUrl: `${publicProductUrl(
        String(creatorResult.data?.username || ""),
        String(product.public_slug),
        process.env.VITE_PUBLIC_URL,
      )}?checkout=canceled`,
      creatorName: String(
        creatorResult.data?.display_name || creatorResult.data?.username || "Bento creator",
      ),
      test: razorpayEnvironment(account.provider_account_id) === "sandbox",
    };
  });

export const verifyRazorpayCheckout = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        sessionId: uuidSchema,
        razorpayPaymentId: paymentIdSchema,
        razorpayOrderId: orderIdSchema,
        razorpaySignature: signatureSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("CHECKOUT_RATE_LIMITER", "razorpay-checkout-verify");
    const db = supabaseAdmin as any;
    const { data: session, error } = await db
      .from("commerce_payment_sessions")
      .select("*")
      .eq("id", data.sessionId)
      .eq("provider", "razorpay")
      .maybeSingle();
    if (error || !session) throw new Error(error?.message || "Checkout was not found.");
    if (new Date(session.expires_at) <= new Date() && session.status !== "paid") {
      throw new Error("This Razorpay checkout has expired.");
    }
    if (session.provider_checkout_id !== data.razorpayOrderId) {
      throw new Error("Razorpay returned a different Order.");
    }
    const account = await getRazorpayPaymentAccountById(session.connection_id);
    if (!account) throw new Error("Razorpay connection was not found.");
    const credentials = await razorpayCredentialsForAccount(account);
    const validSignature = await verifyRazorpayPaymentSignature({
      orderId: session.provider_checkout_id,
      paymentId: data.razorpayPaymentId,
      signature: data.razorpaySignature,
      keySecret: credentials.keySecret,
    });
    if (!validSignature) throw new Error("Razorpay payment signature is invalid.");
    const payment = await razorpayRequest<RazorpayPayment>(
      credentials,
      `/v1/payments/${encodeURIComponent(data.razorpayPaymentId)}`,
    );
    const result = await finalizeRazorpayPayment({ account, session, payment });
    const query = new URLSearchParams({ order: result.orderId });
    if (result.accessToken) query.set("access", result.accessToken);
    const successPath =
      session.metadata?.creator_username && session.metadata?.product_public_slug
        ? publicProductSuccessPath(
            session.metadata.creator_username,
            session.metadata.product_public_slug,
          )
        : `/p/${encodeURIComponent(session.metadata?.product_slug || "product")}/success`;
    return { url: `${appUrl()}${successPath}?${query}` };
  });
