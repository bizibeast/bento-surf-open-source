/* eslint-disable @typescript-eslint/no-explicit-any -- Payment tables are introduced by the pending migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  calculateCommerceAmounts,
  isHostedAccessKind,
  type CommerceBuyerAnswer,
  type CommerceProductKind,
} from "@/lib/commerce";
import { getStripePaymentAccount, stripeRequestForPaymentAccount } from "./client.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
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

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function randomAccessToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createStripeCommerceCheckout(input: {
  product: CheckoutProduct;
  email: string;
  name?: string;
  recordingAddon?: { selected: boolean; amount: number };
  growth: CommerceCheckoutGrowth;
  buyerAnswers?: CommerceBuyerAnswer[];
}) {
  const db = supabaseAdmin as any;
  const account = await getStripePaymentAccount(input.product.creator_id);
  if (!account) throw new Error("This creator has not connected Stripe yet.");
  if (!account.charges_enabled || !account.payouts_enabled) {
    throw new Error("This creator's Stripe account is not ready to accept and receive payments.");
  }
  if (
    account.credential_mode === "restricted_key" &&
    (!account.webhook_endpoint_id || !account.webhook_secret_ciphertext)
  ) {
    throw new Error("This creator must finish the Stripe webhook setup before accepting payments.");
  }

  // Creator-owned credentials charge the creator account directly. Bento never
  // adds an application fee or routes creator revenue through a Bento balance.
  const feeBps = 0;
  const amounts = calculateCommerceAmounts(input.product.price_amount, feeBps);
  const accessToken = isHostedAccessKind(input.product.kind as CommerceProductKind)
    ? randomAccessToken()
    : null;
  const localSessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000);
  const { error: insertError } = await db.from("commerce_payment_sessions").insert({
    id: localSessionId,
    product_id: input.product.id,
    creator_id: input.product.creator_id,
    connection_id: account.id,
    provider: "stripe",
    buyer_email: input.email.toLowerCase(),
    buyer_name: input.name || null,
    gross_amount: amounts.grossAmount,
    platform_fee_bps: amounts.platformFeeBps,
    platform_fee_amount: amounts.platformFeeAmount,
    currency: input.product.currency,
    access_token_hash: accessToken ? await sha256(accessToken) : null,
    recording_addon_selected: Boolean(input.recordingAddon?.selected),
    recording_addon_amount: input.recordingAddon?.amount || 0,
    expires_at: expiresAt.toISOString(),
    metadata: {
      access_token_ciphertext: accessToken ? await encryptServerSecret(accessToken) : null,
      product_slug: input.product.slug,
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

  const success = new URL(
    `${appUrl()}${publicProductSuccessPath(
      input.product.creator_username,
      input.product.public_slug,
    )}`,
  );
  success.searchParams.set("order", "{CHECKOUT_SESSION_ID}");
  if (accessToken) success.searchParams.set("access", accessToken);
  const params = new URLSearchParams({
    mode: input.product.pricing_type === "subscription" ? "subscription" : "payment",
    success_url: success.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
    cancel_url: `${publicProductUrl(
      input.product.creator_username,
      input.product.public_slug,
      process.env.VITE_PUBLIC_URL,
    )}?checkout=canceled`,
    customer_email: input.email.toLowerCase(),
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": input.product.currency,
    "line_items[0][price_data][unit_amount]": String(input.product.price_amount),
    "line_items[0][price_data][product_data][name]": input.product.title,
    "line_items[0][price_data][product_data][description]": input.product.description.slice(0, 500),
    "metadata[bento_session_id]": localSessionId,
    "metadata[bento_product_id]": input.product.id,
    "metadata[bento_creator_id]": input.product.creator_id,
    "metadata[bento_connection_id]": account.id,
    client_reference_id: localSessionId,
    expires_at: String(Math.floor(expiresAt.getTime() / 1_000)),
  });
  for (const [key, value] of Object.entries(commerceCheckoutGrowthMetadata(input.growth))) {
    if (value !== null && value !== "") params.set(`metadata[${key}]`, String(value));
  }
  if (input.product.description.trim()) {
    params.set(
      "line_items[0][price_data][product_data][description]",
      input.product.description.slice(0, 500),
    );
  } else {
    params.delete("line_items[0][price_data][product_data][description]");
  }
  if (input.product.pricing_type === "subscription") {
    params.set(
      "line_items[0][price_data][recurring][interval]",
      input.product.billing_interval || "month",
    );
    if (feeBps > 0) {
      params.set("subscription_data[application_fee_percent]", String(feeBps / 100));
    }
    params.set("subscription_data[metadata][bento_session_id]", localSessionId);
    params.set("subscription_data[metadata][bento_product_id]", input.product.id);
    params.set("subscription_data[metadata][bento_creator_id]", input.product.creator_id);
    params.set("subscription_data[metadata][bento_connection_id]", account.id);
  } else {
    if (amounts.platformFeeAmount > 0) {
      params.set("payment_intent_data[application_fee_amount]", String(amounts.platformFeeAmount));
    }
    params.set("payment_intent_data[metadata][bento_session_id]", localSessionId);
  }

  try {
    const checkout = await stripeRequestForPaymentAccount<{ id: string; url: string | null }>(
      account,
      "/v1/checkout/sessions",
      {
        method: "POST",
        params,
        idempotencyKey: `bento-commerce-${localSessionId}`,
      },
    );
    if (!checkout.url) throw new Error("Stripe did not return a checkout URL.");
    const { error } = await db
      .from("commerce_payment_sessions")
      .update({ provider_checkout_id: checkout.id })
      .eq("id", localSessionId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return {
      url: checkout.url,
      test: String(account.provider_metadata?.environment || "sandbox") !== "production",
    };
  } catch (error) {
    await failCommerceCheckoutSession(localSessionId, error);
    throw error;
  }
}
