import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Creem responses are normalized at the API boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";

export const CREEM_PROVIDER = "creem" as const;
export const CREEM_WEBHOOK_EVENTS = [
  "checkout.completed",
  "subscription.active",
  "subscription.paid",
  "subscription.canceled",
  "subscription.scheduled_cancel",
  "subscription.past_due",
  "subscription.expired",
  "subscription.trialing",
  "subscription.paused",
  "subscription.update",
  "refund.created",
  "dispute.created",
] as const;

export type CreemEnvironment = "test" | "production";

export type CreemPaymentAccount = {
  id: string;
  creator_id: string;
  provider: "creem";
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

const encoder = new TextEncoder();

export function creemApiBase(environment: CreemEnvironment) {
  return environment === "production" ? "https://api.creem.io" : "https://test-api.creem.io";
}

export function assertCreemEnvironment(environment: CreemEnvironment) {
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV;
  if (deployment === "production" && environment !== "production") {
    throw new Error("Use a live Creem API key in production. Test keys belong in staging.");
  }
  if (deployment !== "production" && environment !== "test") {
    throw new Error("Use a test Creem API key. Live keys are blocked outside production.");
  }
  return environment;
}

function creemError(payload: any, status: number) {
  const message = String(
    payload?.message || payload?.error?.message || payload?.error || "",
  ).trim();
  if (status === 401 || status === 403) {
    return "Creem rejected this API key. Check the key and whether Test or Live mode is selected.";
  }
  return message || `Creem request failed (${status}).`;
}

export async function creemRequest<T>(
  apiKey: string,
  environment: CreemEnvironment,
  path: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(`${creemApiBase(environment)}${path}`, {
    method: init.method || "GET",
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(creemError(payload, response.status));
  return payload as T;
}

export async function verifyCreemApiKey(apiKey: string, environment: CreemEnvironment) {
  await creemRequest<{ items: unknown[] }>(
    apiKey,
    environment,
    "/v1/store/search?page_number=1&page_size=1",
  );
}

export async function creemCredentialFingerprint(apiKey: string, environment: CreemEnvironment) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${environment}\u0000${apiKey}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function creemWebhookUrl(connectionId: string) {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/api/webhooks/creem/direct/${encodeURIComponent(connectionId)}`;
}

export async function getCreemPaymentAccount(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", CREEM_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CreemPaymentAccount | null) || null;
}

export async function getCreemPaymentAccountById(connectionId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("id", connectionId)
    .eq("provider", CREEM_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CreemPaymentAccount | null) || null;
}

export function creemEnvironmentForAccount(account: CreemPaymentAccount): CreemEnvironment {
  return account.provider_metadata?.environment === "production" ? "production" : "test";
}

export async function creemApiKeyForAccount(account: CreemPaymentAccount) {
  if (!account.access_token_ciphertext) throw new Error("Creem credentials are incomplete.");
  const apiKey = await decryptServerSecret(account.access_token_ciphertext);
  if (apiKey.length < 16) throw new Error("Creem credentials are invalid. Reconnect Creem.");
  return apiKey;
}

export async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(leftBytes, rightBytes);
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function verifyCreemWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
) {
  return constantTimeEqual(signature.toLowerCase(), await hmacSha256Hex(secret, rawBody));
}
