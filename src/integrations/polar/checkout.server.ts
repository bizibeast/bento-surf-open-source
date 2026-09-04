/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce provider references are added by a pending migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  isHostedAccessKind,
  type CommerceBuyerAnswer,
  type CommerceProductKind,
} from "@/lib/commerce";
import { getPolarPaymentAccount, polarClientForAccount } from "./client.server";
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

async function polarProductHasOpenCheckouts(productId: string, providerProductId: string) {
  const { count, error } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("provider", "polar")
    .in("status", ["pending", "approved"])
    .contains("metadata", { provider_product_id: providerProductId });
  if (error) {
    console.error("[polar] could not verify open product checkouts before archival", error);
    return true;
  }
  return Number(count || 0) > 0;
}

export function polarSupportsCommerceKind(kind: CommerceProductKind) {
  return creatorPaymentCompatibility("polar", kind, "one_time").supported;
}

async function syncedPolarProduct(
  product: CheckoutProduct,
  account: Awaited<ReturnType<typeof getPolarPaymentAccount>>,
) {
  if (!account) throw new Error("Connect Polar in Settings before accepting payments.");
  const db = supabaseAdmin as any;
  const syncHash = await productSyncHash(product);
  const { data: existing, error } = await db
    .from("commerce_product_provider_refs")
    .select("*")
    .eq("product_id", product.id)
    .eq("provider", "polar")
    .eq("provider_account_id", account.provider_account_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing?.sync_hash === syncHash) return existing.provider_product_id as string;

  const polar = await polarClientForAccount(account);
  const common = {
    name: product.title.length >= 3 ? product.title : `${product.title} product`,
    description: product.description || null,
    visibility: "private" as const,
    prices: [
      {
        amountType: "fixed" as const,
        priceAmount: product.price_amount,
        priceCurrency: product.currency as any,
      },
    ],
    organizationId: account.provider_account_id,
    metadata: { bento_product_id: product.id, bento_creator_id: product.creator_id },
  };
  const remote =
    product.pricing_type === "subscription"
      ? await polar.products.create({
          ...common,
          recurringInterval: product.billing_interval || "month",
          recurringIntervalCount: 1,
        })
      : await polar.products.create({ ...common, recurringInterval: null });

  const { error: upsertError } = await db.from("commerce_product_provider_refs").upsert(
    {
      product_id: product.id,
      creator_id: product.creator_id,
      provider: "polar",
      provider_account_id: account.provider_account_id,
      provider_product_id: remote.id,
      sync_hash: syncHash,
    },
    { onConflict: "product_id,provider,provider_account_id" },
  );
  if (upsertError) {
    await polar.products
      .update({ id: remote.id, productUpdate: { isArchived: true } })
      .catch(() => undefined);
    throw new Error(upsertError.message);
  }
  if (existing?.provider_product_id && existing.provider_product_id !== remote.id) {
    if (!(await polarProductHasOpenCheckouts(product.id, existing.provider_product_id))) {
      await polar.products
        .update({ id: existing.provider_product_id, productUpdate: { isArchived: true } })
        .catch((archiveError) => {
          console.error("[polar] superseded product could not be archived", archiveError);
        });
    }
  }
  return remote.id;
}

export async function createPolarCommerceCheckout(input: {
  product: CheckoutProduct;
  email: string;
  name?: string;
  growth: CommerceCheckoutGrowth;
  buyerAnswers?: CommerceBuyerAnswer[];
}) {
  const account = await getPolarPaymentAccount(input.product.creator_id);
  if (!account) throw new Error("This creator has not connected a payment provider yet.");
  if (!account.charges_enabled) {
    throw new Error("This creator's Polar account is not ready to accept payments yet.");
  }
  if (!polarSupportsCommerceKind(input.product.kind as CommerceProductKind)) {
    throw new Error(
      creatorPaymentCompatibility(
        "polar",
        input.product.kind as CommerceProductKind,
        input.product.pricing_type,
      ).reason || "Polar does not support this offer type in Bento.",
    );
  }
  const remoteProductId = await syncedPolarProduct(input.product, account);
  const polar = await polarClientForAccount(account);
  const accessToken = isHostedAccessKind(input.product.kind as CommerceProductKind)
    ? randomAccessToken()
    : null;
  const accessHash = accessToken ? await sha256(accessToken) : "";
  const sessionId = crypto.randomUUID();
  const buyerEmail = input.email.toLowerCase();
  const encryptedAccessToken = accessToken ? await encryptServerSecret(accessToken) : null;
  const { error: sessionError } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .insert({
      id: sessionId,
      product_id: input.product.id,
      creator_id: input.product.creator_id,
      connection_id: account.id,
      provider: "polar",
      buyer_email: buyerEmail,
      buyer_name: input.name || null,
      gross_amount: input.product.price_amount,
      platform_fee_bps: 0,
      platform_fee_amount: 0,
      currency: input.product.currency.toLowerCase(),
      access_token_hash: accessHash || null,
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
  const successQuery = new URLSearchParams();
  successQuery.set("order", "{CHECKOUT_ID}");
  if (accessToken) successQuery.set("access", accessToken);
  let checkout: Awaited<ReturnType<typeof polar.checkouts.create>>;
  try {
    checkout = await polar.checkouts.create({
      products: [remoteProductId],
      customerEmail: buyerEmail,
      customerName: input.name || null,
      successUrl: `${appUrl()}${publicProductSuccessPath(
        input.product.creator_username,
        input.product.public_slug,
      )}?${successQuery.toString().replace("%7BCHECKOUT_ID%7D", "{CHECKOUT_ID}")}`,
      returnUrl: `${publicProductUrl(
        input.product.creator_username,
        input.product.public_slug,
        process.env.VITE_PUBLIC_URL,
      )}?checkout=canceled`,
      metadata: { bento_session_id: sessionId },
    });
  } catch (error) {
    await failCommerceCheckoutSession(sessionId, error, {
      ...(encryptedAccessToken ? { access_token_ciphertext: encryptedAccessToken } : {}),
      checkout_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
    });
    throw error;
  }
  const { error: checkoutUpdateError } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .update({ provider_checkout_id: checkout.id, expires_at: checkout.expiresAt.toISOString() })
    .eq("id", sessionId)
    .eq("status", "pending");
  if (checkoutUpdateError) {
    await failCommerceCheckoutSession(sessionId, checkoutUpdateError, {
      ...(encryptedAccessToken ? { access_token_ciphertext: encryptedAccessToken } : {}),
      provider_checkout_id: checkout.id,
      checkout_error: checkoutUpdateError.message.slice(0, 500),
    });
    throw new Error(
      `Polar checkout was created, but Bento could not save its reference: ${checkoutUpdateError.message}`,
    );
  }
  return { url: checkout.url, test: process.env.POLAR_ENVIRONMENT === "sandbox" };
}
