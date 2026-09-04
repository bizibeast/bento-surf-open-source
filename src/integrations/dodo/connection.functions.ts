/* eslint-disable @typescript-eslint/no-explicit-any -- Creator payment tables are service-role only. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { requireExclusiveCreatorPaymentProvider } from "@/lib/payment-connection-policy.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  DODO_CREATOR_PROVIDER,
  DODO_CREATOR_WEBHOOK_EVENTS,
  assertDodoEnvironmentAllowed,
  createDodoCreatorClient,
  dodoApiKeyFingerprint,
  dodoClientForCreatorAccount,
  dodoCreatorWebhookUrl,
  dodoEnvironmentForAccount,
  getDodoCreatorPaymentAccount,
  type DodoCreatorPaymentAccount,
} from "./creator-client.server";

const apiKeySchema = z.string().trim().min(20, "Enter a valid Dodo API key.").max(1_024);
const environmentSchema = z.enum(["test_mode", "live_mode"]);

function publicConnection(account: DodoCreatorPaymentAccount | null) {
  if (!account) return null;
  const metadata = account.provider_metadata || {};
  return {
    id: account.id,
    provider: DODO_CREATOR_PROVIDER,
    accountId: account.provider_account_id,
    accountName: String(metadata.business_name || metadata.brand_name || "Dodo Payments account"),
    environment: dodoEnvironmentForAccount(account),
    credentialMode: "api_key",
    webhookReady: Boolean(account.webhook_endpoint_id && account.webhook_secret_ciphertext),
    webhookUrl: dodoCreatorWebhookUrl(account.id),
    onboardingStatus: account.onboarding_status,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    connectedAt: account.created_at,
  };
}

async function inspectDodoBusiness(apiKey: string, environment: "test_mode" | "live_mode") {
  const client = createDodoCreatorClient({ apiKey, environment });
  const brands = await client.brands.list();
  const brand = brands.items.find((item) => item.enabled) || brands.items[0];
  if (!brand?.business_id) {
    throw new Error(
      "Dodo did not return an active business. Finish creating your Dodo business first.",
    );
  }
  return { client, brand };
}

export const getMyDodoConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    publicConnection(await getDodoCreatorPaymentAccount(context.userId)),
  );

export const connectDodoApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ apiKey: apiKeySchema, environment: environmentSchema }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, DODO_CREATOR_PROVIDER);
    const environment = assertDodoEnvironmentAllowed(data.environment);
    const apiKey = data.apiKey.trim();
    const { client, brand } = await inspectDodoBusiness(apiKey, environment);
    const fingerprint = await dodoApiKeyFingerprint(apiKey);
    const existing = await getDodoCreatorPaymentAccount(context.userId);
    if (
      existing?.credential_fingerprint === fingerprint &&
      existing.webhook_endpoint_id &&
      existing.webhook_secret_ciphertext
    ) {
      return publicConnection(existing);
    }

    const id = existing?.id || crypto.randomUUID();
    let webhook: Awaited<ReturnType<typeof client.webhooks.create>> | null = null;
    try {
      webhook = await client.webhooks.create({
        url: dodoCreatorWebhookUrl(id),
        description: "Bento creator commerce",
        filter_types: [...DODO_CREATOR_WEBHOOK_EVENTS],
        metadata: { bento_connection_id: id },
      });
      const webhookSecret = await client.webhooks.retrieveSecret(webhook.id);
      const productionReady =
        environment === "test_mode" || brand.verification_status === "Success";
      const record = {
        id,
        creator_id: context.userId,
        provider: DODO_CREATOR_PROVIDER,
        provider_account_id: brand.business_id,
        onboarding_status: productionReady ? "complete" : "pending",
        charges_enabled: productionReady && brand.enabled,
        payouts_enabled: productionReady && brand.enabled,
        details_submitted: brand.verification_status === "Success" || environment === "test_mode",
        country: null,
        default_currency: null,
        requirements: productionReady
          ? { bento_webhook: "ready" }
          : { dodo_business_verification: brand.verification_status, bento_webhook: "ready" },
        provider_metadata: {
          auth_mode: "api_key",
          environment,
          brand_id: brand.brand_id,
          brand_name: brand.name,
          business_name: brand.name,
          support_email: brand.support_email,
          verification_status: brand.verification_status,
        },
        credential_mode: "api_key",
        credential_fingerprint: fingerprint,
        access_token_ciphertext: await encryptServerSecret(apiKey),
        refresh_token_ciphertext: null,
        token_expires_at: null,
        scopes: ["products", "checkout_sessions", "payments", "webhooks"],
        webhook_endpoint_id: webhook.id,
        webhook_secret_ciphertext: await encryptServerSecret(webhookSecret.secret),
      };
      const { data: saved, error } = await (supabaseAdmin as any)
        .from("creator_payment_accounts")
        .upsert(record, { onConflict: "creator_id,provider" })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new Error("This Dodo business is already connected to another Bento account.");
        }
        throw new Error(error.message);
      }
      if (saved.onboarding_status === "complete") {
        const { error: selectionError } = await (supabaseAdmin as any)
          .from("profiles")
          .update({ commerce_payment_provider: DODO_CREATOR_PROVIDER })
          .eq("id", context.userId)
          .is("commerce_payment_provider", null);
        if (selectionError) throw new Error(selectionError.message);
      }
      if (existing?.webhook_endpoint_id && existing.webhook_endpoint_id !== webhook.id) {
        try {
          await (
            await dodoClientForCreatorAccount(existing)
          ).webhooks.delete(existing.webhook_endpoint_id);
        } catch {
          // The new connection is already safe; a revoked old key cannot block replacement.
        }
      }
      return publicConnection(saved);
    } catch (error) {
      if (webhook?.id) await client.webhooks.delete(webhook.id).catch(() => undefined);
      throw error;
    }
  });

export const refreshDodoConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getDodoCreatorPaymentAccount(context.userId);
    if (!account) throw new Error("Connect Dodo Payments before checking its status.");
    const client = await dodoClientForCreatorAccount(account);
    const brands = await client.brands.list();
    const brand = brands.items.find((item) => item.business_id === account.provider_account_id);
    if (!brand) throw new Error("Dodo could not find the connected business.");
    if (!account.webhook_endpoint_id)
      throw new Error("The Dodo webhook is missing. Reconnect Dodo.");
    const webhook = await client.webhooks.retrieve(account.webhook_endpoint_id);
    await client.webhooks.update(account.webhook_endpoint_id, {
      url: dodoCreatorWebhookUrl(account.id),
      description: "Bento creator commerce",
      disabled: false,
      filter_types: [...DODO_CREATOR_WEBHOOK_EVENTS],
      metadata: { bento_connection_id: account.id },
    });
    const webhookReady = !webhook.disabled && webhook.url === dodoCreatorWebhookUrl(account.id);
    const productionReady =
      dodoEnvironmentForAccount(account) === "test_mode" || brand.verification_status === "Success";
    const ready = productionReady && brand.enabled && webhookReady;
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("creator_payment_accounts")
      .update({
        onboarding_status: ready ? "complete" : "pending",
        charges_enabled: ready,
        payouts_enabled: ready,
        details_submitted: productionReady,
        requirements: {
          dodo_business_verification: brand.verification_status,
          bento_webhook: webhookReady ? "ready" : "reconnect_required",
        },
        provider_metadata: {
          ...(account.provider_metadata || {}),
          brand_name: brand.name,
          business_name: brand.name,
          support_email: brand.support_email,
          verification_status: brand.verification_status,
        },
      })
      .eq("id", account.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return publicConnection(updated);
  });

export const disconnectDodoConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getDodoCreatorPaymentAccount(context.userId);
    if (!account) return { ok: true };
    if (account.webhook_endpoint_id) {
      try {
        await (
          await dodoClientForCreatorAccount(account)
        ).webhooks.delete(account.webhook_endpoint_id);
      } catch {
        // Keep local disconnect available after the creator revokes their key.
      }
    }
    const db = supabaseAdmin as any;
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: null })
      .eq("id", context.userId)
      .eq("commerce_payment_provider", DODO_CREATOR_PROVIDER);
    if (selectionError) throw new Error(selectionError.message);
    const { error } = await db
      .from("creator_payment_accounts")
      .delete()
      .eq("id", account.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
