import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe responses are validated at their use sites. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";

export const STRIPE_PROVIDER = "stripe" as const;

export type StripePaymentAccount = {
  id: string;
  creator_id: string;
  provider_account_id: string;
  onboarding_status: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  country: string | null;
  default_currency: string | null;
  requirements: Record<string, unknown> | null;
  provider_metadata: Record<string, unknown> | null;
  credential_mode: "oauth" | "restricted_key" | "api_key";
  credential_fingerprint: string | null;
  access_token_ciphertext: string | null;
  webhook_endpoint_id: string | null;
  webhook_secret_ciphertext: string | null;
  created_at: string;
};

export type StripeAccount = {
  id: string;
  business_profile?: { name?: string | null; url?: string | null };
  business_type?: string | null;
  country?: string | null;
  default_currency?: string | null;
  details_submitted?: boolean;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  email?: string | null;
  requirements?: Record<string, unknown>;
};

export type StripeWebhookEndpoint = {
  id: string;
  url: string;
  status?: string;
  enabled_events?: string[];
  secret?: string;
};

export const STRIPE_DIRECT_ENABLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

function stripeSecretKey() {
  const value = process.env.STRIPE_SECRET_KEY?.trim();
  if (!value) throw new Error("Stripe Connect is not configured yet.");
  return value;
}

function stripeConnectClientId() {
  const value = process.env.STRIPE_CONNECT_CLIENT_ID?.trim();
  if (!value) throw new Error("Stripe Connect is not configured yet.");
  return value;
}

export function stripeRedirectUri() {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/integrations/stripe/callback`;
}

export function stripeAuthorizeUrl(
  state: string,
  prefill: { email?: string | null; businessName?: string | null; url?: string | null } = {},
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: stripeConnectClientId(),
    scope: "read_write",
    redirect_uri: stripeRedirectUri(),
    state,
  });
  if (prefill.email) query.set("stripe_user[email]", prefill.email);
  if (prefill.businessName) query.set("stripe_user[business_name]", prefill.businessName);
  if (prefill.url) query.set("stripe_user[url]", prefill.url);
  return `https://connect.stripe.com/oauth/authorize?${query}`;
}

export async function stripeRequest<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    params?: URLSearchParams;
    connectedAccountId?: string;
    idempotencyKey?: string;
  } = {},
) {
  const headers = new Headers({ Authorization: `Bearer ${stripeSecretKey()}` });
  if (init.params) headers.set("content-type", "application/x-www-form-urlencoded");
  if (init.connectedAccountId) headers.set("Stripe-Account", init.connectedAccountId);
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: init.method || "GET",
    headers,
    body: init.params,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `Stripe request failed (${response.status}).`);
  }
  return payload;
}

export async function stripeDirectRequest<T>(
  restrictedKey: string,
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    params?: URLSearchParams;
    idempotencyKey?: string;
  } = {},
) {
  const headers = new Headers({ Authorization: `Bearer ${restrictedKey}` });
  if (init.params) headers.set("content-type", "application/x-www-form-urlencoded");
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: init.method || "GET",
    headers,
    body: init.params,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: string; type?: string };
  };
  if (!response.ok) {
    const permissionError = response.status === 401 || response.status === 403;
    throw new Error(
      permissionError
        ? "Stripe rejected this restricted key or one of its required permissions is missing."
        : payload.error?.message || `Stripe request failed (${response.status}).`,
    );
  }
  return payload;
}

const STRIPE_DIRECT_PERMISSION_PROBES = [
  "/v1/charges?limit=1",
  "/v1/payment_intents?limit=1",
  "/v1/subscriptions?limit=1",
  "/v1/checkout/sessions?limit=1",
  "/v1/webhook_endpoints?limit=1",
] as const;

export async function verifyStripeDirectRestrictedKey(restrictedKey: string) {
  await Promise.all(
    STRIPE_DIRECT_PERMISSION_PROBES.map((path) =>
      stripeDirectRequest<{ data?: unknown[] }>(restrictedKey, path),
    ),
  );
}

export function stripeDirectWebhookUrl(connectionId: string) {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/api/webhooks/stripe/direct/${encodeURIComponent(connectionId)}`;
}

export function stripeRestrictedKeyEnvironment(key: string) {
  return key.startsWith("rk_live_") ? "production" : "sandbox";
}

export function isStripeRestrictedKey(key: string) {
  return /^rk_(test|live)_[A-Za-z0-9]+$/.test(key.trim());
}

export function assertStripeKeyMatchesEnvironment(key: string) {
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV;
  const environment = stripeRestrictedKeyEnvironment(key);
  if (deployment === "production" && environment !== "production") {
    throw new Error("Use an rk_live_ restricted key in production. Test keys belong in staging.");
  }
  if (deployment === "staging" && environment !== "sandbox") {
    throw new Error("Use an rk_test_ restricted key in staging. Live keys are blocked on staging.");
  }
  return environment;
}

export async function stripeRestrictedKeyFingerprint(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stripeRequestForPaymentAccount<T>(
  account: StripePaymentAccount,
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    params?: URLSearchParams;
    idempotencyKey?: string;
  } = {},
) {
  if (account.credential_mode === "restricted_key") {
    if (!account.access_token_ciphertext) throw new Error("Stripe credentials are incomplete.");
    const restrictedKey = await decryptServerSecret(account.access_token_ciphertext);
    return stripeDirectRequest<T>(restrictedKey, path, init);
  }
  return stripeRequest<T>(path, {
    ...init,
    connectedAccountId: account.provider_account_id,
  });
}

export async function getStripeAccountForPaymentAccount(account: StripePaymentAccount) {
  if (account.credential_mode === "restricted_key") {
    if (!account.access_token_ciphertext) throw new Error("Stripe credentials are incomplete.");
    return stripeDirectRequest<StripeAccount>(
      await decryptServerSecret(account.access_token_ciphertext),
      "/v1/account",
    );
  }
  return getStripeAccount(account.provider_account_id);
}

export async function createStripeDirectWebhookEndpoint(account: StripePaymentAccount) {
  if (account.credential_mode !== "restricted_key" || !account.access_token_ciphertext) {
    throw new Error("This Stripe connection does not use a restricted key.");
  }
  const params = new URLSearchParams({
    url: stripeDirectWebhookUrl(account.id),
    description: "Bento creator commerce",
  });
  STRIPE_DIRECT_ENABLED_EVENTS.forEach((event, index) => {
    params.set(`enabled_events[${index}]`, event);
  });
  return stripeDirectRequest<StripeWebhookEndpoint>(
    await decryptServerSecret(account.access_token_ciphertext),
    "/v1/webhook_endpoints",
    {
      method: "POST",
      params,
      idempotencyKey: `bento-stripe-webhook-${account.id}-${(account.credential_fingerprint || "new").slice(0, 16)}`,
    },
  );
}

export async function deleteStripeDirectWebhookEndpoint(account: StripePaymentAccount) {
  if (
    account.credential_mode !== "restricted_key" ||
    !account.access_token_ciphertext ||
    !account.webhook_endpoint_id
  ) {
    return;
  }
  await stripeDirectRequest(
    await decryptServerSecret(account.access_token_ciphertext),
    `/v1/webhook_endpoints/${encodeURIComponent(account.webhook_endpoint_id)}`,
    { method: "DELETE" },
  );
}

export async function getStripeDirectWebhookEndpoint(
  account: StripePaymentAccount,
  endpointId: string,
) {
  if (account.credential_mode !== "restricted_key" || !account.access_token_ciphertext) {
    throw new Error("This Stripe connection does not use a restricted key.");
  }
  return stripeDirectRequest<StripeWebhookEndpoint>(
    await decryptServerSecret(account.access_token_ciphertext),
    `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
  );
}

export async function updateStripeDirectWebhookEndpoint(account: StripePaymentAccount) {
  if (
    account.credential_mode !== "restricted_key" ||
    !account.access_token_ciphertext ||
    !account.webhook_endpoint_id
  ) {
    throw new Error("This Stripe webhook connection is incomplete.");
  }
  const params = new URLSearchParams({
    url: stripeDirectWebhookUrl(account.id),
    description: "Bento creator commerce",
  });
  STRIPE_DIRECT_ENABLED_EVENTS.forEach((event, index) => {
    params.set(`enabled_events[${index}]`, event);
  });
  return stripeDirectRequest<StripeWebhookEndpoint>(
    await decryptServerSecret(account.access_token_ciphertext),
    `/v1/webhook_endpoints/${encodeURIComponent(account.webhook_endpoint_id)}`,
    { method: "POST", params },
  );
}

export async function exchangeStripeCode(code: string) {
  const response = await fetch("https://connect.stripe.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_secret: stripeSecretKey(),
      grant_type: "authorization_code",
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token: string;
    refresh_token?: string;
    stripe_user_id: string;
    scope: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.stripe_user_id) {
    throw new Error(
      payload.error_description || payload.error || "Stripe rejected the connection.",
    );
  }
  return payload;
}

export function getStripeAccount(accountId: string) {
  return stripeRequest<StripeAccount>(`/v1/accounts/${encodeURIComponent(accountId)}`);
}

export function stripeOnboardingStatus(account: StripeAccount) {
  if (account.charges_enabled && account.payouts_enabled) return "complete" as const;
  if (account.details_submitted) return "restricted" as const;
  return "pending" as const;
}

export function stripeAccountFields(account: StripeAccount) {
  return {
    provider_account_id: account.id,
    onboarding_status: stripeOnboardingStatus(account),
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    details_submitted: Boolean(account.details_submitted),
    country: account.country?.toLowerCase() || null,
    default_currency: account.default_currency?.toLowerCase() || null,
    requirements: account.requirements || {},
    provider_metadata: {
      business_name: account.business_profile?.name || null,
      business_url: account.business_profile?.url || null,
      email: account.email || null,
      business_type: account.business_type || null,
    },
  };
}

export async function getStripePaymentAccount(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", STRIPE_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as StripePaymentAccount | null;
}

export async function getStripePaymentAccountById(connectionId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("id", connectionId)
    .eq("provider", STRIPE_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as StripePaymentAccount | null;
}

export async function disconnectStripeAccount(accountId: string) {
  const response = await fetch("https://connect.stripe.com/oauth/deauthorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_secret: stripeSecretKey(),
      client_id: stripeConnectClientId(),
      stripe_user_id: accountId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error_description?: string;
      error?: string;
    };
    throw new Error(
      payload.error_description || payload.error || "Stripe could not disconnect this account.",
    );
  }
  return (await response.json()) as { stripe_user_id: string };
}

export function stripeWebhookSecret() {
  const value = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (!value) throw new Error("Stripe Connect webhook verification is not configured.");
  return value;
}
