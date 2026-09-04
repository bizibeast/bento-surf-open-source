/* eslint-disable @typescript-eslint/no-explicit-any -- Payment tables are introduced by the pending migration. */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { commercePlatformFeeBps } from "./commerce";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { planHasEntitlement } from "./plans";
import {
  CREATOR_PAYMENT_PROVIDER_DEFINITIONS,
  CREATOR_PAYMENT_PROVIDERS,
  recommendedCreatorPaymentProvider,
  type CreatorPaymentProvider,
} from "./payment-providers";
import { creatorPaymentAccountReady } from "./payment-connection-policy.server";

function isConfigured(provider: CreatorPaymentProvider) {
  const hasEncryptionKey = Boolean(process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY);
  if (provider === "stripe") {
    return hasEncryptionKey;
  }
  if (provider === "paypal") {
    return hasEncryptionKey;
  }
  if (provider === "razorpay") {
    return hasEncryptionKey;
  }
  if (provider === "polar") {
    return Boolean(
      process.env.POLAR_CLIENT_ID && process.env.POLAR_CLIENT_SECRET && hasEncryptionKey,
    );
  }
  if (provider === "dodo") {
    return hasEncryptionKey;
  }
  if (provider === "creem") {
    return hasEncryptionKey;
  }
  return false;
}

function paymentAccountWebhookReady(account: any) {
  if (account.provider === "paypal" && account.credential_mode === "api_key") {
    return Boolean(account.webhook_endpoint_id);
  }
  return Boolean(account.webhook_endpoint_id && account.webhook_secret_ciphertext);
}

export function paymentAccountReady(account: any) {
  return creatorPaymentAccountReady(account);
}

function publicAccount(account: any) {
  const metadata = (account.provider_metadata || {}) as Record<string, unknown>;
  return {
    id: account.id as string,
    provider: account.provider as CreatorPaymentProvider,
    accountId: account.provider_account_id as string,
    accountName: String(
      metadata.business_name ||
        metadata.organization_name ||
        metadata.email ||
        `${account.provider} account`,
    ),
    accountSlug: String(metadata.organization_slug || ""),
    onboardingStatus: account.onboarding_status as string,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    country: (account.country as string | null) || null,
    defaultCurrency: (account.default_currency as string | null) || null,
    requirements: (account.requirements || {}) as Record<string, unknown>,
    credentialMode: String(account.credential_mode || "oauth"),
    webhookReady: paymentAccountWebhookReady(account),
    connectedAt: account.created_at as string,
  };
}

function requestCountry() {
  const request = getRequest() as (Request & { cf?: { country?: string } }) | undefined;
  return request?.cf?.country || request?.headers.get("cf-ipcountry") || null;
}

export const getCreatorPaymentSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const adminDb = supabaseAdmin as any;
    const [{ data: profile, error: profileError }, { data: accounts, error: accountsError }] =
      await Promise.all([
        adminDb
          .from("profiles")
          .select("plan_id, commerce_payment_provider")
          .eq("id", context.userId)
          .single(),
        adminDb
          .from("creator_payment_accounts")
          .select(
            "id, provider, provider_account_id, onboarding_status, charges_enabled, payouts_enabled, details_submitted, country, default_currency, requirements, provider_metadata, credential_mode, webhook_endpoint_id, webhook_secret_ciphertext, created_at",
          )
          .eq("creator_id", context.userId),
      ]);
    if (profileError) throw new Error(profileError.message);
    if (accountsError) throw new Error(accountsError.message);
    const feeBps = commercePlatformFeeBps();
    const connections = accounts || [];
    const configuredSelection = (profile?.commerce_payment_provider ||
      null) as CreatorPaymentProvider | null;
    const selectedProvider = connections.some(
      (account: any) => account.provider === configuredSelection && paymentAccountReady(account),
    )
      ? configuredSelection
      : null;
    return {
      locked: !planHasEntitlement(await getPlan(context.userId), "oneTapCheckout"),
      feeBps,
      selectedProvider,
      recommendedProvider: recommendedCreatorPaymentProvider(requestCountry()),
      connections: connections.map(publicAccount),
      providers: CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => ({
        ...provider,
        configured: isConfigured(provider.id),
      })),
    };
  });

export const selectCreatorPaymentProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ provider: z.enum(CREATOR_PAYMENT_PROVIDERS) }).parse(input))
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan. Upgrade to continue.",
    );
    const adminDb = supabaseAdmin as any;
    const { data: account, error: accountError } = await adminDb
      .from("creator_payment_accounts")
      .select(
        "id, provider, credential_mode, onboarding_status, charges_enabled, payouts_enabled, webhook_endpoint_id, webhook_secret_ciphertext",
      )
      .eq("creator_id", context.userId)
      .eq("provider", data.provider)
      .maybeSingle();
    if (accountError) throw new Error(accountError.message);
    if (!paymentAccountReady(account)) {
      throw new Error("Finish the provider's payment, payout, and webhook setup first.");
    }
    const { error } = await adminDb
      .from("profiles")
      .update({ commerce_payment_provider: data.provider })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { provider: data.provider };
  });
