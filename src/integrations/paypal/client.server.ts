import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- PayPal responses are validated at their use sites. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";

export const PAYPAL_PROVIDER = "paypal" as const;
export const PAYPAL_WEBHOOK_EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.FAILED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.RESOLVED",
] as const;

export type PayPalEnvironment = "sandbox" | "production";
export type PayPalCredentials = { clientId: string; clientSecret: string };
export type PayPalPaymentAccount = {
  id: string;
  creator_id: string;
  provider: "paypal";
  provider_account_id: string;
  onboarding_status: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  default_currency: string | null;
  requirements: Record<string, unknown> | null;
  provider_metadata: Record<string, unknown> | null;
  credential_mode: string;
  credential_fingerprint: string | null;
  access_token_ciphertext: string | null;
  webhook_endpoint_id: string | null;
  webhook_secret_ciphertext: string | null;
  created_at: string;
};

function environment() {
  return process.env.PAYPAL_ENVIRONMENT === "production" ? "production" : "sandbox";
}

export function paypalApiBaseUrl(targetEnvironment: PayPalEnvironment = environment()) {
  return targetEnvironment === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function credentials() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("PayPal Multiparty is not configured yet.");
  return { clientId, clientSecret };
}

export function paypalPartnerMerchantId() {
  const value = process.env.PAYPAL_PARTNER_MERCHANT_ID?.trim();
  if (!value) throw new Error("PayPal partner onboarding is not configured yet.");
  return value;
}

function partnerAttributionId() {
  const value = process.env.PAYPAL_PARTNER_ATTRIBUTION_ID?.trim();
  if (!value) throw new Error("PayPal partner attribution is not configured yet.");
  return value;
}

const cachedTokens = new Map<string, { value: string; expiresAt: number }>();

export async function paypalAccessToken(
  directCredentials?: PayPalCredentials,
  targetEnvironment: PayPalEnvironment = environment(),
) {
  const { clientId, clientSecret } = directCredentials || credentials();
  const cacheKey = `${targetEnvironment}:${await paypalCredentialFingerprint({ clientId, clientSecret })}`;
  const cachedToken = cachedTokens.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const response = await fetch(`${paypalApiBaseUrl(targetEnvironment)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || "PayPal authentication failed.");
  }
  cachedTokens.set(cacheKey, {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(60, payload.expires_in || 300) * 1_000,
  });
  return payload.access_token;
}

function base64UrlJson(value: Record<string, unknown>) {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function paypalAuthAssertion(sellerMerchantId: string) {
  const { clientId } = credentials();
  return `${base64UrlJson({ alg: "none" })}.${base64UrlJson({ iss: clientId, payer_id: sellerMerchantId })}.`;
}

export async function paypalRequest<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    sellerMerchantId?: string;
    requestId?: string;
    includePartnerAttribution?: boolean;
    credentials?: PayPalCredentials;
    environment?: PayPalEnvironment;
  } = {},
) {
  const targetEnvironment = init.environment || environment();
  const headers = new Headers({
    Authorization: `Bearer ${await paypalAccessToken(init.credentials, targetEnvironment)}`,
    "content-type": "application/json",
    Accept: "application/json",
  });
  if (init.sellerMerchantId) {
    headers.set("PayPal-Auth-Assertion", paypalAuthAssertion(init.sellerMerchantId));
  }
  if (init.requestId) headers.set("PayPal-Request-Id", init.requestId);
  if (!init.credentials && init.includePartnerAttribution !== false) {
    headers.set("PayPal-Partner-Attribution-Id", partnerAttributionId());
  }
  const response = await fetch(`${paypalApiBaseUrl(targetEnvironment)}${path}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string;
    details?: Array<{ description?: string }>;
  };
  if (!response.ok) {
    throw new Error(
      payload.details?.[0]?.description ||
        payload.message ||
        `PayPal request failed (${response.status}).`,
    );
  }
  return payload;
}

export async function getPayPalPaymentAccount(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", PAYPAL_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PayPalPaymentAccount | null) || null;
}

export async function getPayPalPaymentAccountById(connectionId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("id", connectionId)
    .eq("provider", PAYPAL_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PayPalPaymentAccount | null) || null;
}

export function paypalEnvironmentForAccount(account: PayPalPaymentAccount): PayPalEnvironment {
  return account.provider_metadata?.environment === "production" ? "production" : "sandbox";
}

export function assertPayPalEnvironment(targetEnvironment: PayPalEnvironment) {
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV;
  if (deployment === "production" && targetEnvironment !== "production") {
    throw new Error(
      "Use live PayPal credentials in production. Sandbox credentials belong in staging.",
    );
  }
  if (deployment !== "production" && targetEnvironment !== "sandbox") {
    throw new Error(
      "Use PayPal sandbox credentials. Live credentials are blocked outside production.",
    );
  }
  return targetEnvironment;
}

export async function paypalCredentialFingerprint(value: PayPalCredentials) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${value.clientId}\u0000${value.clientSecret}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function paypalDirectWebhookUrl(connectionId: string) {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/api/webhooks/paypal/direct/${encodeURIComponent(connectionId)}`;
}

export async function paypalCredentialsForAccount(account: PayPalPaymentAccount) {
  if (account.credential_mode !== "api_key" || !account.access_token_ciphertext) {
    throw new Error("PayPal credentials are incomplete. Reconnect PayPal.");
  }
  const parsed = JSON.parse(await decryptServerSecret(account.access_token_ciphertext));
  if (
    typeof parsed?.clientId !== "string" ||
    parsed.clientId.length < 20 ||
    typeof parsed?.clientSecret !== "string" ||
    parsed.clientSecret.length < 20
  ) {
    throw new Error("PayPal credentials are invalid. Reconnect PayPal.");
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret } as PayPalCredentials;
}

export async function paypalRequestForAccount<T>(
  account: PayPalPaymentAccount,
  path: string,
  init: Omit<Parameters<typeof paypalRequest<T>>[1], "credentials" | "environment"> = {},
) {
  if (account.credential_mode === "api_key") {
    return paypalRequest<T>(path, {
      ...init,
      credentials: await paypalCredentialsForAccount(account),
      environment: paypalEnvironmentForAccount(account),
      includePartnerAttribution: false,
      sellerMerchantId: undefined,
    });
  }
  return paypalRequest<T>(path, {
    ...init,
    sellerMerchantId: account.provider_account_id,
  });
}

export function paypalEnvironment() {
  return environment();
}
