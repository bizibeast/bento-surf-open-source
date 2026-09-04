/* eslint-disable @typescript-eslint/no-explicit-any -- Provider references use service-role tables. */
import type { Currency } from "dodopayments/resources/misc";
import type { TimeInterval } from "dodopayments/resources/subscriptions";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  isHostedAccessKind,
  type CommerceBuyerAnswer,
  type CommerceProductKind,
} from "@/lib/commerce";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  failCommerceCheckoutSession,
  persistCommerceCheckoutGrowth,
  type CommerceCheckoutGrowth,
} from "@/lib/commerce-growth.server";
import {
  configuredAppOrigin,
  publicProductSuccessPath,
  publicProductUrl,
} from "@/lib/application-urls";
import { creatorPaymentCompatibility } from "@/lib/payment-providers";
import {
  dodoClientForCreatorAccount,
  dodoEnvironmentForAccount,
  getDodoCreatorPaymentAccount,
} from "./creator-client.server";

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

async function productSyncHash(product: CheckoutProduct) {
  return sha256(
    JSON.stringify({
      title: product.title,
      description: product.description,
      pricingType: product.pricing_type,
      priceAmount: product.price_amount,
      currency: product.currency,
      billingInterval: product.billing_interval,
    }),
  );
}

async function dodoProductHasOpenCheckouts(productId: string, providerProductId: string) {
  const { count, error } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("provider", "dodo")
    .in("status", ["pending", "approved"])
    .contains("metadata", { provider_product_id: providerProductId });
  if (error) {
    // Keeping an unused remote product is safer than breaking a buyer's open checkout.
    console.error("[dodo] could not verify open product checkouts before archival", error);
    return true;
  }
  return Number(count || 0) > 0;
}

export function dodoSupportsCommerceKind(kind: CommerceProductKind) {
  return creatorPaymentCompatibility("dodo", kind, "one_time").supported;
}

async function syncedDodoProduct(
  product: CheckoutProduct,
  account: NonNullable<Awaited<ReturnType<typeof getDodoCreatorPaymentAccount>>>,
) {
  const db = supabaseAdmin as any;
  const syncHash = await productSyncHash(product);
  const { data: existing, error } = await db
    .from("commerce_product_provider_refs")
    .select("*")
    .eq("product_id", product.id)
    .eq("provider", "dodo")
    .eq("provider_account_id", account.provider_account_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing?.sync_hash === syncHash) return existing.provider_product_id as string;

  const client = await dodoClientForCreatorAccount(account);
  const currency = product.currency.toUpperCase() as Currency;
  const interval = (product.billing_interval || "month") as TimeInterval;
  const common = {
    name: product.title,
    description: product.description || null,
    tax_category: "digital_products" as const,
    metadata: { bento_product_id: product.id, bento_creator_id: product.creator_id },
  };
  const remote = await client.products.create(
    product.pricing_type === "subscription"
      ? {
          ...common,
          price: {
            type: "recurring_price",
            currency,
            discount: 0,
            price: product.price_amount,
            purchasing_power_parity: false,
            payment_frequency_count: 1,
            payment_frequency_interval: interval,
            subscription_period_count: 1,
            subscription_period_interval: interval,
          },
        }
      : {
          ...common,
          price: {
            type: "one_time_price",
            currency,
            discount: 0,
            price: product.price_amount,
            purchasing_power_parity: false,
          },
        },
  );

  const { error: upsertError } = await db.from("commerce_product_provider_refs").upsert(
    {
      product_id: product.id,
      creator_id: product.creator_id,
      provider: "dodo",
      provider_account_id: account.provider_account_id,
      provider_product_id: remote.product_id,
      sync_hash: syncHash,
    },
    { onConflict: "product_id,provider,provider_account_id" },
  );
  if (upsertError) {
    await client.products.archive(remote.product_id).catch(() => undefined);
    throw new Error(upsertError.message);
  }
  if (existing?.provider_product_id && existing.provider_product_id !== remote.product_id) {
    if (!(await dodoProductHasOpenCheckouts(product.id, existing.provider_product_id))) {
      await client.products.archive(existing.provider_product_id).catch((archiveError) => {
        console.error("[dodo] superseded product could not be archived", archiveError);
      });
    }
  }
  return remote.product_id;
}

export async function createDodoCommerceCheckout(input: {
  product: CheckoutProduct;
  email: string;
  name?: string;
  growth: CommerceCheckoutGrowth;
  buyerAnswers?: CommerceBuyerAnswer[];
}) {
  const account = await getDodoCreatorPaymentAccount(input.product.creator_id);
  if (!account) throw new Error("This creator has not connected Dodo Payments yet.");
  if (!account.charges_enabled || !account.webhook_secret_ciphertext) {
    throw new Error("This creator's Dodo Payments account is not ready to accept payments yet.");
  }
  if (!dodoSupportsCommerceKind(input.product.kind as CommerceProductKind)) {
    throw new Error(
      creatorPaymentCompatibility(
        "dodo",
        input.product.kind as CommerceProductKind,
        input.product.pricing_type,
      ).reason || "Dodo Payments does not support this offer type in Bento.",
    );
  }

  const remoteProductId = await syncedDodoProduct(input.product, account);
  const client = await dodoClientForCreatorAccount(account);
  const accessToken = isHostedAccessKind(input.product.kind as CommerceProductKind)
    ? randomAccessToken()
    : null;
  const encryptedAccessToken = accessToken ? await encryptServerSecret(accessToken) : null;
  const sessionId = crypto.randomUUID();
  const buyerEmail = input.email.toLowerCase();
  const { error: sessionError } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .insert({
      id: sessionId,
      product_id: input.product.id,
      creator_id: input.product.creator_id,
      connection_id: account.id,
      provider: "dodo",
      buyer_email: buyerEmail,
      buyer_name: input.name || null,
      gross_amount: input.product.price_amount,
      platform_fee_bps: 0,
      platform_fee_amount: 0,
      currency: input.product.currency.toLowerCase(),
      access_token_hash: accessToken ? await sha256(accessToken) : null,
      metadata: {
        provider_product_id: remoteProductId,
        ...(encryptedAccessToken ? { access_token_ciphertext: encryptedAccessToken } : {}),
        ...(input.buyerAnswers?.length ? { buyer_answers: input.buyerAnswers } : {}),
      },
    });
  if (sessionError) throw new Error(sessionError.message);
  try {
    await persistCommerceCheckoutGrowth({
      sessionId,
      buyerEmail,
      growth: input.growth,
    });
  } catch (error) {
    await failCommerceCheckoutSession(sessionId, error);
    throw error;
  }

  const success = new URLSearchParams({ order: sessionId });
  if (accessToken) success.set("access", accessToken);
  try {
    const checkout = await client.checkoutSessions.create({
      product_cart: [{ product_id: remoteProductId, quantity: 1 }],
      customer: { email: buyerEmail, name: input.name || undefined },
      billing_currency: input.product.currency.toUpperCase() as Currency,
      feature_flags: { allow_currency_selection: false },
      metadata: {
        bento_session_id: sessionId,
        bento_product_id: input.product.id,
        bento_creator_id: input.product.creator_id,
      },
      return_url: `${appUrl()}${publicProductSuccessPath(
        input.product.creator_username,
        input.product.public_slug,
      )}?${success.toString()}`,
      cancel_url: `${publicProductUrl(
        input.product.creator_username,
        input.product.public_slug,
        process.env.VITE_PUBLIC_URL,
      )}?checkout=canceled`,
    });
    if (!checkout.checkout_url) throw new Error("Dodo did not return a checkout URL.");
    const { error: updateError } = await (supabaseAdmin as any)
      .from("commerce_payment_sessions")
      .update({ provider_checkout_id: checkout.session_id })
      .eq("id", sessionId)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);
    return {
      url: checkout.checkout_url,
      test: dodoEnvironmentForAccount(account) === "test_mode",
    };
  } catch (error) {
    await failCommerceCheckoutSession(sessionId, error, {
      ...(encryptedAccessToken ? { access_token_ciphertext: encryptedAccessToken } : {}),
      checkout_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
    });
    throw error;
  }
}
