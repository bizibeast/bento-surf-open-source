import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Payment tables are introduced by the pending migration. */
import { createServerFn } from "@tanstack/react-start";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { consumePaymentOauthState, createPaymentOauthState } from "@/lib/payment-oauth.server";
import { requireExclusiveCreatorPaymentProvider } from "@/lib/payment-connection-policy.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import {
  PAYPAL_PROVIDER,
  PAYPAL_WEBHOOK_EVENTS,
  assertPayPalEnvironment,
  getPayPalPaymentAccount,
  paypalCredentialFingerprint,
  paypalDirectWebhookUrl,
  paypalEnvironment,
  paypalEnvironmentForAccount,
  paypalPartnerMerchantId,
  paypalRequest,
  paypalRequestForAccount,
  type PayPalEnvironment,
  type PayPalPaymentAccount,
} from "./client.server";

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

const credentialsSchema = z.object({
  clientId: z.string().trim().min(20, "Enter the complete PayPal Client ID.").max(256),
  clientSecret: z.string().trim().min(20, "Enter the complete PayPal Client Secret.").max(512),
  environment: z.enum(["sandbox", "production"]),
});

function publicConnection(account: PayPalPaymentAccount | null) {
  if (!account) return null;
  const metadata = account.provider_metadata || {};
  return {
    id: account.id,
    provider: PAYPAL_PROVIDER,
    accountId: account.provider_account_id,
    accountName: String(metadata.business_name || "PayPal account"),
    environment: paypalEnvironmentForAccount(account),
    credentialMode: account.credential_mode,
    webhookReady: Boolean(account.webhook_endpoint_id),
    webhookUrl: paypalDirectWebhookUrl(account.id),
    onboardingStatus: account.onboarding_status,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    connectedAt: account.created_at,
  };
}

async function deleteDirectWebhook(account: PayPalPaymentAccount) {
  if (account.credential_mode !== "api_key" || !account.webhook_endpoint_id) return;
  await paypalRequestForAccount(
    account,
    `/v1/notifications/webhooks/${encodeURIComponent(account.webhook_endpoint_id)}`,
    {
      method: "DELETE",
    },
  );
}

export const getMyPayPalConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => publicConnection(await getPayPalPaymentAccount(context.userId)));

export const connectPayPalApiCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => credentialsSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, PAYPAL_PROVIDER);
    const targetEnvironment = assertPayPalEnvironment(data.environment as PayPalEnvironment);
    const credentials = {
      clientId: data.clientId.trim(),
      clientSecret: data.clientSecret.trim(),
    };
    // Fetching an access token verifies that the ID, secret, and selected environment match.
    await paypalRequest<{ webhooks?: unknown[] }>("/v1/notifications/webhooks", {
      credentials,
      environment: targetEnvironment,
      includePartnerAttribution: false,
    });
    const fingerprint = await paypalCredentialFingerprint(credentials);
    const existing = await getPayPalPaymentAccount(context.userId);
    if (
      existing?.credential_mode === "api_key" &&
      existing.credential_fingerprint === fingerprint &&
      existing.webhook_endpoint_id
    ) {
      return publicConnection(existing);
    }

    const id = existing?.id || crypto.randomUUID();
    let webhook: { id: string } | null = null;
    try {
      webhook = await paypalRequest<{ id: string }>("/v1/notifications/webhooks", {
        method: "POST",
        credentials,
        environment: targetEnvironment,
        includePartnerAttribution: false,
        requestId: `bento-paypal-webhook-${id}`,
        body: {
          url: paypalDirectWebhookUrl(id),
          event_types: PAYPAL_WEBHOOK_EVENTS.map((name) => ({ name })),
        },
      });
      if (!webhook.id) throw new Error("PayPal did not return a webhook ID.");
      const record = {
        id,
        creator_id: context.userId,
        provider: PAYPAL_PROVIDER,
        provider_account_id: credentials.clientId,
        onboarding_status: "complete",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        country: null,
        default_currency: null,
        requirements: { bento_webhook: "ready" },
        provider_metadata: {
          auth_mode: "api_key",
          environment: targetEnvironment,
          business_name: `PayPal ${targetEnvironment === "production" ? "live" : "sandbox"} account`,
        },
        credential_mode: "api_key",
        credential_fingerprint: fingerprint,
        access_token_ciphertext: await encryptServerSecret(JSON.stringify(credentials)),
        refresh_token_ciphertext: null,
        token_expires_at: null,
        scopes: ["orders", "payments", "refunds", "webhooks"],
        webhook_endpoint_id: webhook.id,
        webhook_secret_ciphertext: null,
      };
      const { data: saved, error } = await (supabaseAdmin as any)
        .from("creator_payment_accounts")
        .upsert(record, { onConflict: "creator_id,provider" })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new Error("This PayPal REST app is already connected to another Bento account.");
        }
        throw new Error(error.message);
      }
      const { error: selectionError } = await (supabaseAdmin as any)
        .from("profiles")
        .update({ commerce_payment_provider: PAYPAL_PROVIDER })
        .eq("id", context.userId)
        .is("commerce_payment_provider", null);
      if (selectionError) throw new Error(selectionError.message);
      if (existing?.webhook_endpoint_id && existing.webhook_endpoint_id !== webhook.id) {
        await deleteDirectWebhook(existing).catch(() => undefined);
      }
      return publicConnection(saved);
    } catch (error) {
      if (webhook?.id) {
        await paypalRequest(`/v1/notifications/webhooks/${encodeURIComponent(webhook.id)}`, {
          method: "DELETE",
          credentials,
          environment: targetEnvironment,
          includePartnerAttribution: false,
        }).catch(() => undefined);
      }
      throw error;
    }
  });

export const refreshPayPalConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getPayPalPaymentAccount(context.userId);
    if (!account) throw new Error("Connect PayPal before checking its status.");
    if (account.credential_mode !== "api_key") return publicConnection(account);
    if (!account.webhook_endpoint_id)
      throw new Error("The PayPal webhook is missing. Reconnect PayPal.");
    const webhook = await paypalRequestForAccount<{ id?: string; url?: string }>(
      account,
      `/v1/notifications/webhooks/${encodeURIComponent(account.webhook_endpoint_id)}`,
    );
    const ready =
      webhook.id === account.webhook_endpoint_id &&
      webhook.url === paypalDirectWebhookUrl(account.id);
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("creator_payment_accounts")
      .update({
        onboarding_status: ready ? "complete" : "pending",
        charges_enabled: ready,
        payouts_enabled: ready,
        requirements: { bento_webhook: ready ? "ready" : "reconnect_required" },
      })
      .eq("id", account.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return publicConnection(updated);
  });

export const beginPayPalConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, PAYPAL_PROVIDER);
    const state = await createPaymentOauthState(context.userId, PAYPAL_PROVIDER);
    const returnUrl = new URL(`${appUrl()}/integrations/paypal/callback`);
    returnUrl.searchParams.set("state", state);
    const referral = await paypalRequest<{ links: Array<{ href: string; rel: string }> }>(
      "/v2/customer/partner-referrals",
      {
        method: "POST",
        requestId: `bento-paypal-onboard-${context.userId}`,
        body: {
          tracking_id: state,
          partner_config_override: {
            return_url: returnUrl.toString(),
            return_url_description: "Return to bento.surf",
          },
          operations: [
            {
              operation: "API_INTEGRATION",
              api_integration_preference: {
                rest_api_integration: {
                  integration_method: "PAYPAL",
                  integration_type: "THIRD_PARTY",
                  third_party_details: { features: ["PAYMENT", "REFUND", "PARTNER_FEE"] },
                },
              },
            },
          ],
          products: ["EXPRESS_CHECKOUT"],
          legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
        },
      },
    );
    const action = referral.links.find((link) => link.rel === "action_url");
    if (!action?.href) throw new Error("PayPal did not return a seller onboarding link.");
    return { url: action.href };
  });

export const completePayPalConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        state: z.string().min(20).max(512),
        merchantId: z.string().min(5).max(128),
        permissionsGranted: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (!data.permissionsGranted) throw new Error("PayPal permissions were not granted.");
    const oauthState = await consumePaymentOauthState(PAYPAL_PROVIDER, data.state);
    // The state was minted for a specific creator; the browser finishing the
    // flow must be that same signed-in creator (blocks account-linking CSRF).
    if (oauthState.creator_id !== context.userId) {
      throw new Error("This PayPal onboarding link belongs to a different account.");
    }
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(oauthState.creator_id, PAYPAL_PROVIDER);
    const status = await paypalRequest<any>(
      `/v1/customer/partners/${encodeURIComponent(paypalPartnerMerchantId())}/merchant-integrations/${encodeURIComponent(data.merchantId)}`,
    );
    // merchantId is client-supplied; PayPal echoes the tracking_id we sent at
    // referral time, so the merchant must be the one onboarded for THIS state.
    if (status?.tracking_id !== data.state) {
      throw new Error("PayPal merchant does not match this onboarding session.");
    }
    const activeProduct = (status.products || []).some(
      (product: { status?: string; vetting_status?: string }) =>
        product.status === "ACTIVE" || product.vetting_status === "SUBSCRIBED",
    );
    const ready = Boolean(
      status.payments_receivable && status.primary_email_confirmed && activeProduct,
    );
    const db = supabaseAdmin as any;
    const { data: connected, error } = await db
      .from("creator_payment_accounts")
      .upsert(
        {
          creator_id: oauthState.creator_id,
          provider: PAYPAL_PROVIDER,
          provider_account_id: data.merchantId,
          onboarding_status: ready ? "complete" : "pending",
          charges_enabled: ready,
          payouts_enabled: ready,
          details_submitted: Boolean(status.primary_email_confirmed),
          requirements: {
            payments_receivable: Boolean(status.payments_receivable),
            primary_email_confirmed: Boolean(status.primary_email_confirmed),
            products: status.products || [],
          },
          provider_metadata: {
            environment: paypalEnvironment(),
            merchant_id: data.merchantId,
          },
        },
        { onConflict: "creator_id,provider" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (ready) {
      const { error: selectionError } = await db
        .from("profiles")
        .update({ commerce_payment_provider: PAYPAL_PROVIDER })
        .eq("id", oauthState.creator_id);
      if (selectionError) throw new Error(selectionError.message);
    }
    return { id: connected.id, ready };
  });

export const disconnectPayPalConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getPayPalPaymentAccount(context.userId);
    if (!account) return { ok: true };
    if (account.credential_mode === "api_key") {
      await deleteDirectWebhook(account).catch(() => undefined);
    }
    const db = supabaseAdmin as any;
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: null })
      .eq("id", context.userId)
      .eq("commerce_payment_provider", PAYPAL_PROVIDER);
    if (selectionError) throw new Error(selectionError.message);
    const { error } = await db
      .from("creator_payment_accounts")
      .delete()
      .eq("id", account.id)
      .eq("creator_id", context.userId)
      .eq("provider", PAYPAL_PROVIDER);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
