import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Private payment tables are added by a pending migration. */
import { createServerFn } from "@tanstack/react-start";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import { consumePaymentOauthState, createPaymentOauthState } from "@/lib/payment-oauth.server";
import { requireExclusiveCreatorPaymentProvider } from "@/lib/payment-connection-policy.server";
import {
  POLAR_PROVIDER,
  POLAR_WEBHOOK_EVENTS,
  createPolarClient,
  exchangePolarCode,
  getPolarPaymentAccount,
  polarAuthorizeUrl,
  polarClientForAccount,
  polarOrganizationReadiness,
} from "./client.server";

async function selectedPolarOrganization(
  polar: ReturnType<typeof createPolarClient>,
  expectedOrganizationId?: string,
) {
  if (expectedOrganizationId) {
    return polar.organizations.get({ id: expectedOrganizationId });
  }
  const pages = await polar.organizations.listOrganizations({ limit: 1 });
  for await (const page of pages) {
    const organization = page.result.items[0];
    if (organization) return organization;
  }
  throw new Error("Polar did not return the selected organization.");
}

function polarAccountStatus(organization: Awaited<ReturnType<typeof selectedPolarOrganization>>) {
  const readiness = polarOrganizationReadiness(organization);
  return {
    onboarding_status: readiness.onboardingStatus,
    charges_enabled: readiness.chargesEnabled,
    payouts_enabled: readiness.payoutsEnabled,
    details_submitted: readiness.detailsSubmitted,
    country: organization.country || null,
    default_currency: organization.defaultPresentmentCurrency.toLowerCase(),
    requirements: {
      organization_status: organization.status,
      checkout_payments: organization.capabilities.checkoutPayments,
      payouts: organization.capabilities.payouts,
    },
    provider_metadata: {
      organization_name: organization.name,
      organization_slug: organization.slug,
      organization_status: organization.status,
    },
  };
}

function publicConnection(account: any) {
  if (!account) return null;
  const metadata = (account.provider_metadata || {}) as Record<string, unknown>;
  return {
    id: account.id as string,
    provider: POLAR_PROVIDER,
    organizationId: account.provider_account_id as string,
    organizationName: String(metadata.organization_name || "Polar organization"),
    organizationSlug: String(metadata.organization_slug || ""),
    environment: process.env.POLAR_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    onboardingStatus: account.onboarding_status as string,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    connectedAt: account.created_at as string,
  };
}

export const getMyPaymentConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => publicConnection(await getPolarPaymentAccount(context.userId)));

export const beginPolarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, POLAR_PROVIDER);
    const state = await createPaymentOauthState(context.userId, POLAR_PROVIDER);
    return { url: polarAuthorizeUrl(state) };
  });

export const completePolarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ code: z.string().min(8).max(4_096), state: z.string().min(20).max(512) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = supabaseAdmin as any;
    const oauthState = await consumePaymentOauthState(POLAR_PROVIDER, data.state);
    // The state was minted for a specific creator; the browser finishing the
    // flow must be that same signed-in creator (blocks account-linking CSRF).
    if (oauthState.creator_id !== context.userId) {
      throw new Error("This Polar connection link belongs to a different account.");
    }
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(oauthState.creator_id, POLAR_PROVIDER);

    const tokens = await exchangePolarCode(data.code);
    const polar = createPolarClient(tokens.access_token);
    const organization = await selectedPolarOrganization(polar);

    const existing = await getPolarPaymentAccount(oauthState.creator_id);
    const connectionId = existing?.id || crypto.randomUUID();
    const webhook = await polar.webhooks.createWebhookEndpoint({
      url: `${configuredAppOrigin(process.env.VITE_APP_URL)}/api/webhooks/polar/${connectionId}`,
      format: "raw",
      name: "bento.surf orders",
      events: [...POLAR_WEBHOOK_EVENTS],
      organizationId: organization.id,
    });

    const accessTokenCiphertext = await encryptServerSecret(tokens.access_token);
    const refreshTokenCiphertext = tokens.refresh_token
      ? await encryptServerSecret(tokens.refresh_token)
      : null;
    const webhookSecretCiphertext = await encryptServerSecret(webhook.secret);
    const record = {
      id: connectionId,
      creator_id: oauthState.creator_id,
      provider: POLAR_PROVIDER,
      provider_account_id: organization.id,
      ...polarAccountStatus(organization),
      access_token_ciphertext: accessTokenCiphertext,
      refresh_token_ciphertext: refreshTokenCiphertext,
      token_expires_at: new Date(Date.now() + tokens.expires_in * 1_000).toISOString(),
      scopes: tokens.scope.split(/\s+/).filter(Boolean),
      webhook_endpoint_id: webhook.id,
      webhook_secret_ciphertext: webhookSecretCiphertext,
    };
    const { data: connected, error: upsertError } = await db
      .from("creator_payment_accounts")
      .upsert(record, { onConflict: "creator_id,provider" })
      .select("*")
      .single();
    if (upsertError) {
      await polar.webhooks.deleteWebhookEndpoint({ id: webhook.id }).catch(() => undefined);
      throw new Error(upsertError.message);
    }
    if (existing?.webhook_endpoint_id && existing.webhook_endpoint_id !== webhook.id) {
      await polar.webhooks
        .deleteWebhookEndpoint({ id: existing.webhook_endpoint_id })
        .catch(() => undefined);
    }
    if (record.onboarding_status === "complete") {
      const { error: selectionError } = await db
        .from("profiles")
        .update({ commerce_payment_provider: POLAR_PROVIDER })
        .eq("id", oauthState.creator_id)
        .is("commerce_payment_provider", null);
      if (selectionError) throw new Error(selectionError.message);
    }
    return publicConnection(connected);
  });

export const refreshPolarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getPolarPaymentAccount(context.userId);
    if (!account) throw new Error("Connect Polar before checking its status.");
    const polar = await polarClientForAccount(account);
    if (account.webhook_endpoint_id) {
      await polar.webhooks.updateWebhookEndpoint({
        id: account.webhook_endpoint_id,
        webhookEndpointUpdate: {
          url: `${configuredAppOrigin(process.env.VITE_APP_URL)}/api/webhooks/polar/${account.id}`,
          name: "bento.surf orders",
          format: "raw",
          events: [...POLAR_WEBHOOK_EVENTS],
          enabled: true,
        },
      });
    }
    const organization = await selectedPolarOrganization(polar, account.provider_account_id);
    const status = polarAccountStatus(organization);
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("creator_payment_accounts")
      .update(status)
      .eq("id", account.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (status.onboarding_status === "complete") {
      const { error: selectionError } = await (supabaseAdmin as any)
        .from("profiles")
        .update({ commerce_payment_provider: POLAR_PROVIDER })
        .eq("id", context.userId)
        .is("commerce_payment_provider", null);
      if (selectionError) throw new Error(selectionError.message);
    }
    return publicConnection(updated);
  });

export const disconnectPolarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getPolarPaymentAccount(context.userId);
    if (!account) return { ok: true };
    if (account.webhook_endpoint_id) {
      const polar = await polarClientForAccount(account);
      await polar.webhooks
        .deleteWebhookEndpoint({ id: account.webhook_endpoint_id })
        .catch(() => undefined);
    }
    const db = supabaseAdmin as any;
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: null })
      .eq("id", context.userId)
      .eq("commerce_payment_provider", POLAR_PROVIDER);
    if (selectionError) throw new Error(selectionError.message);
    const { error } = await db
      .from("creator_payment_accounts")
      .delete()
      .eq("id", account.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
