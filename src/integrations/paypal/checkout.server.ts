/* eslint-disable @typescript-eslint/no-explicit-any -- Payment tables are introduced by the pending migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  calculateCommerceAmounts,
  commercePlatformFeeBps,
  isHostedAccessKind,
  type CommerceBuyerAnswer,
  type CommerceProductKind,
} from "@/lib/commerce";
import {
  getPayPalPaymentAccount,
  paypalEnvironmentForAccount,
  paypalRequestForAccount,
} from "./client.server";
import { paypalMinorUnits, paypalMoney } from "./money";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  commerceOrderMetadata,
  finalizeCommerceFulfillment,
} from "@/lib/commerce-fulfillment.server";
import {
  failCommerceCheckoutSession,
  persistCommerceCheckoutGrowth,
  type CommerceCheckoutGrowth,
} from "@/lib/commerce-growth.server";
import { configuredAppOrigin, publicProductUrl } from "@/lib/application-urls";

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
};

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPayPalCommerceCheckout(input: {
  product: CheckoutProduct;
  email: string;
  name?: string;
  recordingAddon?: { selected: boolean; amount: number };
  growth: CommerceCheckoutGrowth;
  buyerAnswers?: CommerceBuyerAnswer[];
}) {
  if (input.product.pricing_type === "subscription") {
    throw new Error(
      "PayPal subscriptions are not enabled in Bento yet. Use Stripe for this product.",
    );
  }
  const db = supabaseAdmin as any;
  const account = await getPayPalPaymentAccount(input.product.creator_id);
  if (!account?.charges_enabled) throw new Error("This creator's PayPal account is not ready yet.");
  const feeBps = commercePlatformFeeBps();
  const amounts = calculateCommerceAmounts(input.product.price_amount, feeBps);
  const directCredentials = account.credential_mode === "api_key";
  if (directCredentials && amounts.platformFeeAmount > 0) {
    throw new Error("Direct PayPal connections require Bento's platform fee to remain 0%.");
  }
  const localSessionId = crypto.randomUUID();
  const accessToken = isHostedAccessKind(input.product.kind as CommerceProductKind)
    ? randomToken()
    : null;
  const captureToken = randomToken();
  const { error: insertError } = await db.from("commerce_payment_sessions").insert({
    id: localSessionId,
    product_id: input.product.id,
    creator_id: input.product.creator_id,
    connection_id: account.id,
    provider: "paypal",
    buyer_email: input.email.toLowerCase(),
    buyer_name: input.name || null,
    gross_amount: amounts.grossAmount,
    platform_fee_bps: amounts.platformFeeBps,
    platform_fee_amount: amounts.platformFeeAmount,
    currency: input.product.currency,
    access_token_hash: accessToken ? await sha256(accessToken) : null,
    recording_addon_selected: Boolean(input.recordingAddon?.selected),
    recording_addon_amount: input.recordingAddon?.amount || 0,
    metadata: {
      capture_token_hash: await sha256(captureToken),
      product_slug: input.product.slug,
      product_public_slug: input.product.public_slug,
      creator_username: input.product.creator_username,
      access_token_ciphertext: accessToken ? await encryptServerSecret(accessToken) : null,
      recording_addon_selected: Boolean(input.recordingAddon?.selected),
      recording_addon_amount: input.recordingAddon?.amount || 0,
      ...(input.buyerAnswers?.length ? { buyer_answers: input.buyerAnswers } : {}),
    },
  });
  if (insertError) throw new Error(insertError.message);
  try {
    await persistCommerceCheckoutGrowth({
      sessionId: localSessionId,
      buyerEmail: input.email,
      growth: input.growth,
    });
  } catch (error) {
    await failCommerceCheckoutSession(localSessionId, error);
    throw error;
  }

  const returnUrl = new URL(`${appUrl()}/payments/paypal/return`);
  returnUrl.searchParams.set("session", localSessionId);
  returnUrl.searchParams.set("capture", captureToken);
  if (accessToken) returnUrl.searchParams.set("access", accessToken);
  const currency = input.product.currency.toUpperCase();
  try {
    const order = await paypalRequestForAccount<{
      id: string;
      links: Array<{ href: string; rel: string }>;
    }>(account, "/v2/checkout/orders", {
      method: "POST",
      requestId: `bento-commerce-${localSessionId}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: localSessionId,
            custom_id: localSessionId,
            invoice_id: `bento-${localSessionId}`,
            description: input.product.title,
            ...(!directCredentials ? { payee: { merchant_id: account.provider_account_id } } : {}),
            amount: {
              currency_code: currency,
              value: paypalMoney(amounts.grossAmount, input.product.currency),
            },
            ...(!directCredentials && amounts.platformFeeAmount > 0
              ? {
                  payment_instruction: {
                    disbursement_mode: "INSTANT",
                    platform_fees: [
                      {
                        amount: {
                          currency_code: currency,
                          value: paypalMoney(amounts.platformFeeAmount, input.product.currency),
                        },
                      },
                    ],
                  },
                }
              : {}),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "bento.surf",
              user_action: "PAY_NOW",
              return_url: returnUrl.toString(),
              cancel_url: `${publicProductUrl(
                input.product.creator_username,
                input.product.public_slug,
                process.env.VITE_PUBLIC_URL,
              )}?checkout=canceled`,
            },
          },
        },
      },
    });
    const approval = order.links.find(
      (link) => link.rel === "payer-action" || link.rel === "approve",
    );
    if (!approval?.href) throw new Error("PayPal did not return a checkout approval URL.");
    const { error } = await db
      .from("commerce_payment_sessions")
      .update({ provider_checkout_id: order.id })
      .eq("id", localSessionId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { url: approval.href, test: paypalEnvironmentForAccount(account) !== "production" };
  } catch (error) {
    await failCommerceCheckoutSession(localSessionId, error);
    throw error;
  }
}

export async function capturePayPalCommerceOrder(input: {
  sessionId: string;
  captureToken: string;
  orderId: string;
}) {
  const db = supabaseAdmin as any;
  const { data: local, error } = await db
    .from("commerce_payment_sessions")
    .select("*")
    .eq("id", input.sessionId)
    .eq("provider", "paypal")
    .eq("provider_checkout_id", input.orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!local) throw new Error("PayPal checkout does not match a Bento payment session.");
  if (local.status === "paid")
    return {
      productSlug: local.metadata.product_public_slug || local.metadata.product_slug,
      creatorUsername: local.metadata.creator_username || null,
      orderId: input.orderId,
    };
  if (local.status !== "pending" || new Date(local.expires_at).getTime() < Date.now()) {
    throw new Error("This PayPal checkout has expired.");
  }
  if ((await sha256(input.captureToken)) !== local.metadata.capture_token_hash) {
    throw new Error("Invalid PayPal return token.");
  }
  const account = await getPayPalPaymentAccount(local.creator_id);
  if (!account || account.id !== local.connection_id)
    throw new Error("PayPal connection not found.");
  const captured = await paypalRequestForAccount<any>(
    account,
    `/v2/checkout/orders/${encodeURIComponent(input.orderId)}/capture`,
    {
      method: "POST",
      body: {},
      requestId: `bento-capture-${local.id}`,
    },
  );
  if (captured.status !== "COMPLETED") throw new Error("PayPal did not complete this payment.");
  const unit = captured.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture || capture.status !== "COMPLETED")
    throw new Error("PayPal capture was not completed.");
  if (
    account.credential_mode !== "api_key" &&
    unit.payee?.merchant_id &&
    unit.payee.merchant_id !== account.provider_account_id
  ) {
    throw new Error("PayPal seller does not match the connected Bento account.");
  }
  const gross = paypalMinorUnits(capture.amount?.value, local.currency);
  if (
    gross !== Number(local.gross_amount) ||
    capture.amount?.currency_code?.toLowerCase() !== local.currency
  ) {
    throw new Error("PayPal payment amount does not match the Bento order.");
  }
  const breakdown = capture.seller_receivable_breakdown || {};
  const processorFee = Math.max(
    0,
    paypalMinorUnits(breakdown.paypal_fee?.value || 0, local.currency),
  );
  const reportedPlatformFee = (breakdown.platform_fees || []).reduce(
    (sum: number, fee: any) => sum + paypalMinorUnits(fee.amount?.value || 0, local.currency),
    0,
  );
  if (reportedPlatformFee !== Number(local.platform_fee_amount)) {
    throw new Error("PayPal platform fee does not match Bento's plan fee.");
  }
  const { data: fulfilled, error: fulfillmentError } = await db.rpc(
    "fulfill_provider_commerce_order",
    {
      p_product_id: local.product_id,
      p_buyer_email: local.buyer_email,
      p_buyer_name:
        [captured.payer?.name?.given_name, captured.payer?.name?.surname]
          .filter(Boolean)
          .join(" ") ||
        local.buyer_name ||
        "",
      p_provider: "paypal",
      p_provider_account_id: account.provider_account_id,
      p_provider_checkout_id: input.orderId,
      p_provider_payment_id: capture.id,
      p_provider_subscription_id: "",
      p_gross_amount: local.gross_amount,
      p_platform_fee_bps: local.platform_fee_bps,
      p_platform_fee_amount: local.platform_fee_amount,
      p_processor_fee_amount: processorFee,
      p_tax_amount: 0,
      p_net_amount: Math.max(0, local.gross_amount - local.platform_fee_amount - processorFee),
      p_currency: local.currency,
      p_metadata: commerceOrderMetadata(local, {
        bento_session_id: local.id,
        paypal_order_id: input.orderId,
        paypal_capture_id: capture.id,
        recording_addon_selected: Boolean(local.recording_addon_selected),
        recording_addon_amount: Number(local.recording_addon_amount || 0),
      }),
      p_access_token_hash: local.access_token_hash,
    },
  );
  if (fulfillmentError || !fulfilled?.order_id) {
    throw new Error(fulfillmentError?.message || "PayPal order could not be fulfilled.");
  }
  await finalizeCommerceFulfillment({
    session: local,
    orderId: fulfilled.order_id,
    providerCheckoutId: input.orderId,
  });
  return {
    productSlug: local.metadata.product_public_slug || local.metadata.product_slug,
    creatorUsername: local.metadata.creator_username || null,
    orderId: input.orderId,
  };
}
