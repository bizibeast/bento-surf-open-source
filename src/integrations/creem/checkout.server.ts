/* eslint-disable @typescript-eslint/no-explicit-any -- Provider references use service-role tables. */
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
  creemApiKeyForAccount,
  creemEnvironmentForAccount,
  creemRequest,
  getCreemPaymentAccount,
  type CreemPaymentAccount,
} from "./client.server";

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

type CreemProduct = { id: string };
type CreemCheckout = { id: string; checkout_url: string };

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

async function productSyncHash(product: CheckoutProduct) {
  return sha256(
    JSON.stringify({
      title: product.title,
      description: product.description,
      pricingType: product.pricing_type,
      priceAmount: product.price_amount,
      currency: product.currency,
      billingInterval: product.billing_interval,
      // Bump when the remotely-synced checkout configuration changes so
      // existing creator products are recreated with the safe return URL.
      checkoutConfigVersion: 2,
    }),
  );
}

export function creemSupportsCommerceKind(kind: CommerceProductKind) {
  return creatorPaymentCompatibility("creem", kind, "one_time").supported;
}

function billingPeriod(interval: CheckoutProduct["billing_interval"]) {
  const periods = {
    day: "every-day",
    week: "every-week",
    month: "every-month",
    year: "every-year",
  } as const;
  return periods[interval || "month"];
}

async function syncedCreemProduct(product: CheckoutProduct, account: CreemPaymentAccount) {
  const db = supabaseAdmin as any;
  const syncHash = await productSyncHash(product);
  const { data: existing, error } = await db
    .from("commerce_product_provider_refs")
    .select("*")
    .eq("product_id", product.id)
    .eq("provider", "creem")
    .eq("provider_account_id", account.provider_account_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing?.sync_hash === syncHash) return existing.provider_product_id as string;

  if (product.price_amount < 100) {
    throw new Error("Creem requires paid products to cost at least 1.00 in the selected currency.");
  }
  const apiKey = await creemApiKeyForAccount(account);
  const remote = await creemRequest<CreemProduct>(
    apiKey,
    creemEnvironmentForAccount(account),
    "/v1/store",
    {
      method: "POST",
      body: {
        name: product.title,
        description: product.description || product.title,
        price: product.price_amount,
        currency: product.currency.toUpperCase(),
        billing_type: product.pricing_type === "subscription" ? "recurring" : "onetime",
        ...(product.pricing_type === "subscription"
          ? { billing_period: billingPeriod(product.billing_interval) }
          : {}),
        tax_mode: "exclusive",
        tax_category: "digital-goods-service",
        // A Creem-hosted checkout created outside Bento has no local order
        // reference, so it must never land on the verified success route.
        default_success_url: publicProductUrl(
          product.creator_username,
          product.public_slug,
          process.env.VITE_PUBLIC_URL,
        ),
      },
    },
  );
  if (!remote.id) throw new Error("Creem did not return a product ID.");
  const { error: upsertError } = await db.from("commerce_product_provider_refs").upsert(
    {
      product_id: product.id,
      creator_id: product.creator_id,
      provider: "creem",
      provider_account_id: account.provider_account_id,
      provider_product_id: remote.id,
      sync_hash: syncHash,
    },
    { onConflict: "product_id,provider,provider_account_id" },
  );
  if (upsertError) throw new Error(upsertError.message);
  return remote.id;
}

export async function createCreemCommerceCheckout(input: {
  product: CheckoutProduct;
  email: string;
  name?: string;
  growth: CommerceCheckoutGrowth;
  buyerAnswers?: CommerceBuyerAnswer[];
}) {
  const account = await getCreemPaymentAccount(input.product.creator_id);
  if (!account) throw new Error("This creator has not connected Creem yet.");
  if (!account.charges_enabled || !account.webhook_secret_ciphertext) {
    throw new Error("This creator's Creem account is not ready to accept payments yet.");
  }
  if (!creemSupportsCommerceKind(input.product.kind as CommerceProductKind)) {
    throw new Error(
      creatorPaymentCompatibility(
        "creem",
        input.product.kind as CommerceProductKind,
        input.product.pricing_type,
      ).reason || "Creem cannot sell this offer type.",
    );
  }

  const remoteProductId = await syncedCreemProduct(input.product, account);
  const accessToken = isHostedAccessKind(input.product.kind as CommerceProductKind)
    ? randomAccessToken()
    : null;
  const encryptedAccessToken = accessToken ? await encryptServerSecret(accessToken) : null;
  const sessionId = crypto.randomUUID();
  const buyerEmail = input.email.toLowerCase();
  const db = supabaseAdmin as any;
  const { error: sessionError } = await db.from("commerce_payment_sessions").insert({
    id: sessionId,
    product_id: input.product.id,
    creator_id: input.product.creator_id,
    connection_id: account.id,
    provider: "creem",
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
    const checkout = await creemRequest<CreemCheckout>(
      await creemApiKeyForAccount(account),
      creemEnvironmentForAccount(account),
      "/v1/checkouts",
      {
        method: "POST",
        body: {
          product_id: remoteProductId,
          request_id: sessionId,
          units: 1,
          customer: { email: buyerEmail },
          success_url: `${appUrl()}${publicProductSuccessPath(
            input.product.creator_username,
            input.product.public_slug,
          )}?${success.toString()}`,
          metadata: {
            bento_session_id: sessionId,
            bento_product_id: input.product.id,
            bento_creator_id: input.product.creator_id,
            ...(input.name ? { bento_buyer_name: input.name.slice(0, 120) } : {}),
          },
        },
      },
    );
    if (!checkout.id || !checkout.checkout_url) {
      throw new Error("Creem did not return a checkout URL.");
    }
    const { error: updateError } = await db
      .from("commerce_payment_sessions")
      .update({ provider_checkout_id: checkout.id })
      .eq("id", sessionId)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);
    return { url: checkout.checkout_url, test: creemEnvironmentForAccount(account) === "test" };
  } catch (error) {
    await failCommerceCheckoutSession(sessionId, error, {
      ...(encryptedAccessToken ? { access_token_ciphertext: encryptedAccessToken } : {}),
      checkout_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
    });
    throw error;
  }
}
