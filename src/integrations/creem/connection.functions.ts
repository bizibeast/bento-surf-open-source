/* eslint-disable @typescript-eslint/no-explicit-any -- Creator payment rows are service-role only. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { requireExclusiveCreatorPaymentProvider } from "@/lib/payment-connection-policy.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  CREEM_PROVIDER,
  CREEM_WEBHOOK_EVENTS,
  assertCreemEnvironment,
  creemApiKeyForAccount,
  creemCredentialFingerprint,
  creemEnvironmentForAccount,
  creemWebhookUrl,
  getCreemPaymentAccount,
  verifyCreemApiKey,
  type CreemEnvironment,
  type CreemPaymentAccount,
} from "./client.server";

const apiKeySchema = z.string().trim().min(16, "Enter the complete Creem API key.").max(512);
const environmentSchema = z.enum(["test", "production"]);
const webhookSecretSchema = z
  .string()
  .trim()
  .min(16, "Enter the complete webhook secret.")
  .max(512);

function publicConnection(account: CreemPaymentAccount | null) {
  if (!account) return null;
  const metadata = account.provider_metadata || {};
  return {
    id: account.id,
    provider: CREEM_PROVIDER,
    accountId: account.provider_account_id,
    accountName: String(metadata.business_name || "Creem account"),
    environment: creemEnvironmentForAccount(account),
    credentialMode: "api_key",
    webhookReady: Boolean(account.webhook_endpoint_id && account.webhook_secret_ciphertext),
    webhookUrl: creemWebhookUrl(account.id),
    webhookEvents: [...CREEM_WEBHOOK_EVENTS],
    onboardingStatus: account.onboarding_status,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    connectedAt: account.created_at,
  };
}

async function requireStore(creatorId: string) {
  await requirePlanEntitlement(
    creatorId,
    "oneTapCheckout",
    "Connected payments are included with the Store plan.",
  );
}

export const getMyCreemConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => publicConnection(await getCreemPaymentAccount(context.userId)));

export const connectCreemApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ apiKey: apiKeySchema, environment: environmentSchema }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireStore(context.userId);
    await requireExclusiveCreatorPaymentProvider(context.userId, CREEM_PROVIDER);
    const apiKey = data.apiKey.trim();
    const environment = assertCreemEnvironment(data.environment as CreemEnvironment);
    await verifyCreemApiKey(apiKey, environment);
    const fingerprint = await creemCredentialFingerprint(apiKey, environment);
    const existing = await getCreemPaymentAccount(context.userId);
    if (existing?.credential_fingerprint === fingerprint) return publicConnection(existing);

    const db = supabaseAdmin as any;
    const id = existing?.id || crypto.randomUUID();
    const { data: saved, error } = await db
      .from("creator_payment_accounts")
      .upsert(
        {
          id,
          creator_id: context.userId,
          provider: CREEM_PROVIDER,
          provider_account_id: `creem_${environment}_${fingerprint.slice(0, 32)}`,
          onboarding_status: "pending",
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: true,
          country: null,
          default_currency: "usd",
          requirements: { bento_webhook: "manual_setup_required" },
          provider_metadata: {
            auth_mode: "api_key",
            environment,
            business_name: `Creem ${environment === "production" ? "live" : "test"} account`,
          },
          credential_mode: "api_key",
          credential_fingerprint: fingerprint,
          access_token_ciphertext: await encryptServerSecret(apiKey),
          refresh_token_ciphertext: null,
          token_expires_at: null,
          scopes: ["products:write", "checkouts:write"],
          webhook_endpoint_id: null,
          webhook_secret_ciphertext: null,
        },
        { onConflict: "creator_id,provider" },
      )
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") {
        throw new Error("This Creem API key is already connected to another Bento account.");
      }
      throw new Error(error.message);
    }
    return publicConnection(saved);
  });

export const configureCreemWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ webhookSecret: webhookSecretSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requireStore(context.userId);
    const current = await getCreemPaymentAccount(context.userId);
    if (!current) throw new Error("Connect your Creem API key first.");
    await verifyCreemApiKey(
      await creemApiKeyForAccount(current),
      creemEnvironmentForAccount(current),
    );
    const db = supabaseAdmin as any;
    const { data: updated, error } = await db
      .from("creator_payment_accounts")
      .update({
        onboarding_status: "complete",
        charges_enabled: true,
        payouts_enabled: true,
        requirements: { bento_webhook: "configured" },
        webhook_endpoint_id: "merchant_dashboard",
        webhook_secret_ciphertext: await encryptServerSecret(data.webhookSecret.trim()),
      })
      .eq("id", current.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: CREEM_PROVIDER })
      .eq("id", context.userId)
      .is("commerce_payment_provider", null);
    if (selectionError) throw new Error(selectionError.message);
    return publicConnection(updated);
  });

export const refreshCreemConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const current = await getCreemPaymentAccount(context.userId);
    if (!current) throw new Error("Connect Creem before checking its status.");
    await verifyCreemApiKey(
      await creemApiKeyForAccount(current),
      creemEnvironmentForAccount(current),
    );
    const webhookReady = Boolean(current.webhook_endpoint_id && current.webhook_secret_ciphertext);
    const db = supabaseAdmin as any;
    const { data: updated, error } = await db
      .from("creator_payment_accounts")
      .update({
        onboarding_status: webhookReady ? "complete" : "pending",
        charges_enabled: webhookReady,
        payouts_enabled: webhookReady,
        details_submitted: true,
        requirements: { bento_webhook: webhookReady ? "configured" : "manual_setup_required" },
      })
      .eq("id", current.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return publicConnection(updated);
  });

export const disconnectCreemConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const current = await getCreemPaymentAccount(context.userId);
    if (!current) return { ok: true };
    const db = supabaseAdmin as any;
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: null })
      .eq("id", context.userId)
      .eq("commerce_payment_provider", CREEM_PROVIDER);
    if (selectionError) throw new Error(selectionError.message);
    const { error } = await db
      .from("creator_payment_accounts")
      .delete()
      .eq("id", current.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
