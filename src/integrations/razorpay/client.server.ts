import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Razorpay API payloads are normalized at the boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";

export const RAZORPAY_PROVIDER = "razorpay" as const;
export const RAZORPAY_WEBHOOK_EVENTS = [
  "payment.captured",
  "payment.failed",
  "refund.processed",
  "payment.dispute.created",
  "payment.dispute.under_review",
  "payment.dispute.action_required",
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",
] as const;

export type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
};

export type RazorpayPaymentAccount = {
  id: string;
  creator_id: string;
  provider: "razorpay";
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

function basicAuth(credentials: RazorpayCredentials) {
  return `Basic ${btoa(`${credentials.keyId}:${credentials.keySecret}`)}`;
}

function razorpayError(payload: any, status: number) {
  const description = String(payload?.error?.description || payload?.error?.reason || "").trim();
  if (status === 401 || /auth|credential|key/i.test(description)) {
    return "Razorpay rejected these API keys. Check that the Key ID and Key Secret belong to the same mode.";
  }
  return description || `Razorpay request failed (${status}).`;
}

export async function razorpayRequest<T>(
  credentials: RazorpayCredentials,
  path: string,
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(`https://api.razorpay.com${path}`, {
    method: init.method || "GET",
    headers: {
      Authorization: basicAuth(credentials),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(razorpayError(payload, response.status));
  return payload as T;
}

export function razorpayEnvironment(keyId: string) {
  return keyId.startsWith("rzp_live_") ? "production" : "sandbox";
}

export function isRazorpayKeyId(keyId: string) {
  return /^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId.trim());
}

export function assertRazorpayEnvironment(keyId: string) {
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV;
  const environment = razorpayEnvironment(keyId);
  if (deployment === "production" && environment !== "production") {
    throw new Error("Use live Razorpay keys in production. Test keys belong in staging.");
  }
  if (deployment === "staging" && environment !== "sandbox") {
    throw new Error("Use test Razorpay keys in staging. Live keys are blocked on staging.");
  }
  return environment;
}

export async function razorpayCredentialFingerprint(credentials: RazorpayCredentials) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${credentials.keyId}\u0000${credentials.keySecret}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyRazorpayCredentials(credentials: RazorpayCredentials) {
  await razorpayRequest<{ entity: string; items: unknown[] }>(
    credentials,
    "/v1/payments?count=1&skip=0",
  );
}

export function razorpayWebhookUrl(connectionId: string) {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/api/webhooks/razorpay/direct/${encodeURIComponent(connectionId)}`;
}

export async function getRazorpayPaymentAccount(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", RAZORPAY_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RazorpayPaymentAccount | null) || null;
}

export async function getRazorpayPaymentAccountById(connectionId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("id", connectionId)
    .eq("provider", RAZORPAY_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RazorpayPaymentAccount | null) || null;
}

export async function razorpayCredentialsForAccount(account: RazorpayPaymentAccount) {
  if (!account.access_token_ciphertext) throw new Error("Razorpay credentials are incomplete.");
  const parsed = JSON.parse(await decryptServerSecret(account.access_token_ciphertext));
  if (!isRazorpayKeyId(parsed?.keyId) || typeof parsed?.keySecret !== "string") {
    throw new Error("Razorpay credentials are invalid. Reconnect Razorpay.");
  }
  return { keyId: parsed.keyId, keySecret: parsed.keySecret } as RazorpayCredentials;
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

export async function verifyRazorpayPaymentSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}) {
  const expected = await hmacSha256Hex(input.keySecret, `${input.orderId}|${input.paymentId}`);
  return constantTimeEqual(input.signature, expected);
}

export async function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
) {
  return constantTimeEqual(signature, await hmacSha256Hex(webhookSecret, rawBody));
}
