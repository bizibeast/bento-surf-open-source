/* eslint-disable @typescript-eslint/no-explicit-any -- Creator payment rows are service-role only. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { requireExclusiveCreatorPaymentProvider } from "@/lib/payment-connection-policy.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  RAZORPAY_PROVIDER,
  RAZORPAY_WEBHOOK_EVENTS,
  assertRazorpayEnvironment,
  getRazorpayPaymentAccount,
  razorpayCredentialFingerprint,
  razorpayCredentialsForAccount,
  razorpayWebhookUrl,
  verifyRazorpayCredentials,
  type RazorpayPaymentAccount,
} from "./client.server";

const keyIdSchema = z
  .string()
  .trim()
  .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "Enter a valid rzp_test_ or rzp_live_ Key ID.")
  .max(128);
const keySecretSchema = z.string().trim().min(16, "Enter the complete Key Secret.").max(512);
const webhookSecretSchema = z.string().trim().min(16).max(256);

function publicConnection(account: RazorpayPaymentAccount | null) {
  if (!account) return null;
  const metadata = account.provider_metadata || {};
  return {
    id: account.id,
    provider: RAZORPAY_PROVIDER,
    accountId: account.provider_account_id,
    accountName: String(metadata.business_name || "Razorpay account"),
    environment: String(metadata.environment || "sandbox"),
    credentialMode: "api_key",
    webhookReady: Boolean(account.webhook_endpoint_id && account.webhook_secret_ciphertext),
    webhookUrl: razorpayWebhookUrl(account.id),
    webhookEvents: [...RAZORPAY_WEBHOOK_EVENTS],
    onboardingStatus: account.onboarding_status,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    connectedAt: account.created_at,
  };
}

export const getMyRazorpayConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    publicConnection(await getRazorpayPaymentAccount(context.userId)),
  );

export const connectRazorpayApiKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ keyId: keyIdSchema, keySecret: keySecretSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, RAZORPAY_PROVIDER);
    const credentials = { keyId: data.keyId.trim(), keySecret: data.keySecret.trim() };
    const environment = assertRazorpayEnvironment(credentials.keyId);
    await verifyRazorpayCredentials(credentials);
    const fingerprint = await razorpayCredentialFingerprint(credentials);
    const existing = await getRazorpayPaymentAccount(context.userId);
    if (existing?.credential_fingerprint === fingerprint) return publicConnection(existing);

    const db = supabaseAdmin as any;
    const id = existing?.id || crypto.randomUUID();
    const record = {
      id,
      creator_id: context.userId,
      provider: RAZORPAY_PROVIDER,
      provider_account_id: credentials.keyId,
      onboarding_status: "pending",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      country: environment === "production" ? "IN" : null,
      default_currency: "inr",
      requirements: { bento_webhook: "manual_setup_required" },
      provider_metadata: {
        auth_mode: "api_key",
        environment,
        business_name: `Razorpay ${environment === "production" ? "live" : "test"} account`,
      },
      credential_mode: "api_key",
      credential_fingerprint: fingerprint,
      access_token_ciphertext: await encryptServerSecret(JSON.stringify(credentials)),
      refresh_token_ciphertext: null,
      token_expires_at: null,
      scopes: ["orders:write", "payments:read", "refunds:read"],
      webhook_endpoint_id: null,
      webhook_secret_ciphertext: null,
    };
    const { data: saved, error } = await db
      .from("creator_payment_accounts")
      .upsert(record, { onConflict: "creator_id,provider" })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") {
        throw new Error("This Razorpay Key ID is already connected to another Bento account.");
      }
      throw new Error(error.message);
    }
    return publicConnection(saved);
  });

export const configureRazorpayWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ webhookSecret: webhookSecretSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    const current = await getRazorpayPaymentAccount(context.userId);
    if (!current) throw new Error("Connect your Razorpay API keys first.");
    await verifyRazorpayCredentials(await razorpayCredentialsForAccount(current));
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
      .update({ commerce_payment_provider: RAZORPAY_PROVIDER })
      .eq("id", context.userId)
      .is("commerce_payment_provider", null);
    if (selectionError) throw new Error(selectionError.message);
    return publicConnection(updated);
  });

export const refreshRazorpayConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const current = await getRazorpayPaymentAccount(context.userId);
    if (!current) throw new Error("Connect Razorpay before checking its status.");
    await verifyRazorpayCredentials(await razorpayCredentialsForAccount(current));
    const webhookReady = Boolean(current.webhook_endpoint_id && current.webhook_secret_ciphertext);
    const db = supabaseAdmin as any;
    const { data: updated, error } = await db
      .from("creator_payment_accounts")
      .update({
        onboarding_status: webhookReady ? "complete" : "pending",
        charges_enabled: webhookReady,
        payouts_enabled: webhookReady,
        details_submitted: true,
        requirements: {
          bento_webhook: webhookReady ? "configured" : "manual_setup_required",
        },
      })
      .eq("id", current.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return publicConnection(updated);
  });

export const disconnectRazorpayConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const current = await getRazorpayPaymentAccount(context.userId);
    if (!current) return { ok: true };
    const db = supabaseAdmin as any;
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: null })
      .eq("id", context.userId)
      .eq("commerce_payment_provider", RAZORPAY_PROVIDER);
    if (selectionError) throw new Error(selectionError.message);
    const { error } = await db
      .from("creator_payment_accounts")
      .delete()
      .eq("id", current.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
