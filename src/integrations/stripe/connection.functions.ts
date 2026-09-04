/* eslint-disable @typescript-eslint/no-explicit-any -- Payment tables are introduced by the pending migration. */
import { createServerFn } from "@tanstack/react-start";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createPaymentOauthState, consumePaymentOauthState } from "@/lib/payment-oauth.server";
import { requireExclusiveCreatorPaymentProvider } from "@/lib/payment-connection-policy.server";
import { encryptServerSecret } from "@/lib/secret-crypto.server";
import { configuredAppOrigin, publicProfileUrl } from "@/lib/application-urls";
import {
  STRIPE_PROVIDER,
  STRIPE_DIRECT_ENABLED_EVENTS,
  assertStripeKeyMatchesEnvironment,
  createStripeDirectWebhookEndpoint,
  deleteStripeDirectWebhookEndpoint,
  disconnectStripeAccount,
  exchangeStripeCode,
  getStripeAccount,
  getStripeAccountForPaymentAccount,
  getStripeDirectWebhookEndpoint,
  getStripePaymentAccount,
  stripeRequestForPaymentAccount,
  stripeDirectWebhookUrl,
  updateStripeDirectWebhookEndpoint,
  stripeAccountFields,
  stripeAuthorizeUrl,
  stripeRestrictedKeyFingerprint,
  verifyStripeDirectRestrictedKey,
  type StripeAccount,
  type StripePaymentAccount,
} from "./client.server";

const restrictedKeySchema = z
  .string()
  .trim()
  .min(24)
  .max(512)
  .regex(
    /^rk_(test|live)_[A-Za-z0-9]+$/,
    "Use a Stripe restricted key beginning with rk_test_ or rk_live_. Secret keys are not accepted.",
  );

function metadataForAccount(
  account: StripeAccount,
  existing: Record<string, unknown> = {},
  environment?: "sandbox" | "production",
) {
  return {
    ...existing,
    auth_mode: "restricted_key",
    environment: environment || existing.environment || "sandbox",
    business_name: account.business_profile?.name || null,
    business_url: account.business_profile?.url || null,
    email: account.email || null,
    business_type: account.business_type || null,
  };
}

function directAccountFields(
  account: StripeAccount,
  webhookReady: boolean,
  metadata: Record<string, unknown>,
) {
  const fields = stripeAccountFields(account);
  const stripeReady = fields.onboarding_status === "complete";
  return {
    ...fields,
    onboarding_status:
      stripeReady && webhookReady ? "complete" : stripeReady ? "pending" : fields.onboarding_status,
    requirements: {
      ...(account.requirements || {}),
      bento_webhook: webhookReady ? "ready" : "manual_setup_required",
    },
    provider_metadata: metadata,
  };
}

function verifiedDirectAccount(accountId: string): StripeAccount {
  return {
    id: accountId,
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
  };
}

function publicConnection(account: any) {
  if (!account) return null;
  const metadata = (account.provider_metadata || {}) as Record<string, unknown>;
  return {
    id: account.id as string,
    provider: STRIPE_PROVIDER,
    accountId: account.provider_account_id as string,
    accountName: String(metadata.business_name || metadata.email || "Stripe account"),
    environment: String(metadata.environment || "sandbox"),
    credentialMode: String(account.credential_mode || "oauth"),
    webhookReady: Boolean(account.webhook_endpoint_id && account.webhook_secret_ciphertext),
    webhookUrl:
      account.credential_mode === "restricted_key" ? stripeDirectWebhookUrl(account.id) : null,
    onboardingStatus: account.onboarding_status as string,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    connectedAt: account.created_at as string,
  };
}

export const getMyStripeConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => publicConnection(await getStripePaymentAccount(context.userId)));

export const connectStripeRestrictedKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ restrictedKey: restrictedKeySchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, STRIPE_PROVIDER);
    const restrictedKey = data.restrictedKey.trim();
    const environment = assertStripeKeyMatchesEnvironment(restrictedKey);
    await verifyStripeDirectRestrictedKey(restrictedKey);

    const db = supabaseAdmin as any;
    const existing = await getStripePaymentAccount(context.userId);
    const fingerprint = await stripeRestrictedKeyFingerprint(restrictedKey);
    const stripeAccount = verifiedDirectAccount(`rk_${fingerprint}`);
    if (
      existing?.credential_mode === "restricted_key" &&
      existing.credential_fingerprint === fingerprint &&
      existing.webhook_endpoint_id &&
      existing.webhook_secret_ciphertext
    ) {
      return publicConnection(existing);
    }
    if (existing?.credential_mode === "restricted_key") {
      try {
        await deleteStripeDirectWebhookEndpoint(existing);
      } catch {
        // A revoked or rotated key must not prevent its local replacement.
      }
    }

    const id = existing?.id || crypto.randomUUID();
    const providerMetadata = metadataForAccount(stripeAccount, {}, environment);
    const initialFields = directAccountFields(stripeAccount, false, providerMetadata);
    const { data: saved, error: saveError } = await db
      .from("creator_payment_accounts")
      .upsert(
        {
          id,
          creator_id: context.userId,
          provider: STRIPE_PROVIDER,
          ...initialFields,
          credential_mode: "restricted_key",
          credential_fingerprint: fingerprint,
          access_token_ciphertext: await encryptServerSecret(restrictedKey),
          refresh_token_ciphertext: null,
          token_expires_at: null,
          scopes: [
            "checkout_sessions:write",
            "payment_intents:read",
            "charges:read",
            "subscriptions:read",
            "webhook_endpoints:write",
          ],
          webhook_endpoint_id: null,
          webhook_secret_ciphertext: null,
        },
        { onConflict: "creator_id,provider" },
      )
      .select("*")
      .single();
    if (saveError) {
      if (saveError.code === "23505") {
        throw new Error("This Stripe account is already connected to another Bento account.");
      }
      throw new Error(saveError.message);
    }

    let connected = saved as StripePaymentAccount;
    try {
      const endpoint = await createStripeDirectWebhookEndpoint(connected);
      if (!endpoint.id || !endpoint.secret) {
        throw new Error("Stripe did not return the new webhook credentials.");
      }
      const readyFields = directAccountFields(stripeAccount, true, providerMetadata);
      const { data: ready, error: readyError } = await db
        .from("creator_payment_accounts")
        .update({
          ...readyFields,
          webhook_endpoint_id: endpoint.id,
          webhook_secret_ciphertext: await encryptServerSecret(endpoint.secret),
        })
        .eq("id", connected.id)
        .eq("creator_id", context.userId)
        .select("*")
        .single();
      if (readyError) throw new Error(readyError.message);
      connected = ready as StripePaymentAccount;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook setup failed.";
      await db
        .from("creator_payment_accounts")
        .update({
          requirements: {
            ...(stripeAccount.requirements || {}),
            bento_webhook: "manual_setup_required",
            bento_webhook_error: message.slice(0, 300),
          },
        })
        .eq("id", connected.id)
        .eq("creator_id", context.userId);
    }

    if (connected.onboarding_status === "complete") {
      const { error: selectionError } = await db
        .from("profiles")
        .update({ commerce_payment_provider: STRIPE_PROVIDER })
        .eq("id", context.userId)
        .is("commerce_payment_provider", null);
      if (selectionError) throw new Error(selectionError.message);
    }
    return publicConnection(connected);
  });

export const configureStripeWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        endpointId: z
          .string()
          .trim()
          .regex(/^we_[A-Za-z0-9]+$/, "Enter a valid Stripe endpoint ID."),
        signingSecret: z
          .string()
          .trim()
          .min(16)
          .max(512)
          .regex(/^whsec_[A-Za-z0-9]+$/, "Enter a valid Stripe webhook signing secret."),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, STRIPE_PROVIDER);
    const current = await getStripePaymentAccount(context.userId);
    if (!current || current.credential_mode !== "restricted_key") {
      throw new Error("Connect a Stripe restricted key first.");
    }
    const endpoint = await getStripeDirectWebhookEndpoint(current, data.endpointId);
    if (endpoint.url !== stripeDirectWebhookUrl(current.id)) {
      throw new Error("This Stripe webhook points to a different URL. Copy the Bento URL exactly.");
    }
    if (endpoint.status && endpoint.status !== "enabled") {
      throw new Error("Enable this webhook endpoint in Stripe before saving it.");
    }
    const enabled = new Set(endpoint.enabled_events || []);
    const missing = STRIPE_DIRECT_ENABLED_EVENTS.filter((event) => !enabled.has(event));
    if (missing.length) {
      throw new Error(`Add the required Stripe webhook events: ${missing.join(", ")}.`);
    }
    const stripeAccount = verifiedDirectAccount(current.provider_account_id);
    const metadata = metadataForAccount(
      stripeAccount,
      (current.provider_metadata || {}) as Record<string, unknown>,
      String(current.provider_metadata?.environment) === "production" ? "production" : "sandbox",
    );
    const fields = directAccountFields(stripeAccount, true, metadata);
    const db = supabaseAdmin as any;
    const { data: updated, error } = await db
      .from("creator_payment_accounts")
      .update({
        ...fields,
        webhook_endpoint_id: data.endpointId,
        webhook_secret_ciphertext: await encryptServerSecret(data.signingSecret.trim()),
      })
      .eq("id", current.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (updated.onboarding_status === "complete") {
      const { error: selectionError } = await db
        .from("profiles")
        .update({ commerce_payment_provider: STRIPE_PROVIDER })
        .eq("id", context.userId)
        .is("commerce_payment_provider", null);
      if (selectionError) throw new Error(selectionError.message);
    }
    return publicConnection(updated);
  });

export const beginStripeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(context.userId, STRIPE_PROVIDER);
    const db = supabaseAdmin as any;
    const [{ data: profile }, { data: authUser }] = await Promise.all([
      db.from("profiles").select("username, display_name").eq("id", context.userId).maybeSingle(),
      supabaseAdmin.auth.admin.getUserById(context.userId),
    ]);
    const state = await createPaymentOauthState(context.userId, STRIPE_PROVIDER);
    const origin = configuredAppOrigin(process.env.VITE_APP_URL);
    return {
      url: stripeAuthorizeUrl(state, {
        email: authUser?.user?.email,
        businessName: profile?.display_name || profile?.username,
        url: profile?.username
          ? publicProfileUrl(profile.username, null, process.env.VITE_PUBLIC_URL)
          : origin,
      }),
    };
  });

export const completeStripeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ code: z.string().min(8).max(4_096), state: z.string().min(20).max(512) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const oauthState = await consumePaymentOauthState(STRIPE_PROVIDER, data.state);
    // The state was minted for a specific creator; the browser finishing the
    // flow must be that same signed-in creator (blocks account-linking CSRF).
    if (oauthState.creator_id !== context.userId) {
      throw new Error("This Stripe connection link belongs to a different account.");
    }
    await requirePlanEntitlement(
      context.userId,
      "oneTapCheckout",
      "Connected payments are included with the Store plan.",
    );
    await requireExclusiveCreatorPaymentProvider(oauthState.creator_id, STRIPE_PROVIDER);
    const tokens = await exchangeStripeCode(data.code);
    const stripeAccount = await getStripeAccount(tokens.stripe_user_id);
    const accountFields = stripeAccountFields(stripeAccount);
    const ready = accountFields.onboarding_status === "complete";
    const record = {
      creator_id: oauthState.creator_id,
      provider: STRIPE_PROVIDER,
      ...accountFields,
      scopes: tokens.scope ? [tokens.scope] : [],
    };
    const db = supabaseAdmin as any;
    const { data: connected, error } = await db
      .from("creator_payment_accounts")
      .upsert(record, { onConflict: "creator_id,provider" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (ready) {
      const { error: selectionError } = await db
        .from("profiles")
        .update({ commerce_payment_provider: STRIPE_PROVIDER })
        .eq("id", oauthState.creator_id);
      if (selectionError) throw new Error(selectionError.message);
    }
    return publicConnection(connected);
  });

export const refreshStripeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const current = await getStripePaymentAccount(context.userId);
    if (!current) throw new Error("Connect Stripe before checking its status.");
    let fields: Record<string, unknown>;
    if (current.credential_mode === "restricted_key") {
      const stripeAccount = verifiedDirectAccount(current.provider_account_id);
      await Promise.all(
        [
          "/v1/charges?limit=1",
          "/v1/payment_intents?limit=1",
          "/v1/subscriptions?limit=1",
          "/v1/checkout/sessions?limit=1",
          "/v1/webhook_endpoints?limit=1",
        ].map((path) => stripeRequestForPaymentAccount(current, path)),
      );
      const webhookReady = Boolean(
        current.webhook_endpoint_id && current.webhook_secret_ciphertext,
      );
      if (webhookReady && current.webhook_endpoint_id) {
        const endpoint = await getStripeDirectWebhookEndpoint(current, current.webhook_endpoint_id);
        if (endpoint.url !== stripeDirectWebhookUrl(current.id) || endpoint.status === "disabled") {
          throw new Error("The Stripe webhook is disabled or points to a different URL.");
        }
        const enabled = new Set(endpoint.enabled_events || []);
        if (STRIPE_DIRECT_ENABLED_EVENTS.some((event) => !enabled.has(event))) {
          await updateStripeDirectWebhookEndpoint(current);
        }
      }
      fields = directAccountFields(
        stripeAccount,
        webhookReady,
        metadataForAccount(
          stripeAccount,
          (current.provider_metadata || {}) as Record<string, unknown>,
          String(current.provider_metadata?.environment) === "production"
            ? "production"
            : "sandbox",
        ),
      );
    } else {
      fields = stripeAccountFields(await getStripeAccountForPaymentAccount(current));
    }
    const db = supabaseAdmin as any;
    const { data: refreshed, error } = await db
      .from("creator_payment_accounts")
      .update(fields)
      .eq("id", current.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (fields.onboarding_status === "complete") {
      const { error: selectionError } = await db
        .from("profiles")
        .update({ commerce_payment_provider: STRIPE_PROVIDER })
        .eq("id", context.userId)
        .is("commerce_payment_provider", null);
      if (selectionError) throw new Error(selectionError.message);
    }
    return publicConnection(refreshed);
  });

export const disconnectStripeConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await getStripePaymentAccount(context.userId);
    if (!account) return { ok: true };
    if (account.credential_mode === "restricted_key") {
      try {
        await deleteStripeDirectWebhookEndpoint(account);
      } catch {
        // Local deletion must remain possible after a key is revoked in Stripe.
      }
    } else {
      await disconnectStripeAccount(account.provider_account_id);
    }
    const db = supabaseAdmin as any;
    const { error: selectionError } = await db
      .from("profiles")
      .update({ commerce_payment_provider: null })
      .eq("id", context.userId)
      .eq("commerce_payment_provider", STRIPE_PROVIDER);
    if (selectionError) throw new Error(selectionError.message);
    const { error } = await db
      .from("creator_payment_accounts")
      .delete()
      .eq("id", account.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
