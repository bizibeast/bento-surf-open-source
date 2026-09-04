import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Creator payment accounts are read with the service role. */
import DodoPayments from "dodopayments";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";

export const DODO_CREATOR_PROVIDER = "dodo" as const;

export type DodoCreatorEnvironment = "test_mode" | "live_mode";

export type DodoCreatorPaymentAccount = {
  id: string;
  creator_id: string;
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

export const DODO_CREATOR_WEBHOOK_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "payment.cancelled",
  "refund.succeeded",
  "dispute.opened",
  "dispute.challenged",
  "dispute.won",
  "dispute.lost",
  "dispute.cancelled",
  "dispute.accepted",
  "dispute.expired",
  "subscription.active",
  "subscription.renewed",
  "subscription.updated",
  "subscription.cancelled",
  "subscription.failed",
  "subscription.on_hold",
  "subscription.expired",
] as const;

export function dodoCreatorWebhookUrl(connectionId: string) {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/api/webhooks/dodo/direct/${encodeURIComponent(connectionId)}`;
}

export function assertDodoEnvironmentAllowed(environment: DodoCreatorEnvironment) {
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV;
  if (deployment === "production" && environment !== "live_mode") {
    throw new Error("Use a live Dodo API key in production. Test keys belong in staging.");
  }
  if (deployment !== "production" && environment !== "test_mode") {
    throw new Error("Use a test Dodo API key. Live keys are blocked outside production.");
  }
  return environment;
}

export function createDodoCreatorClient(input: {
  apiKey: string;
  environment: DodoCreatorEnvironment;
  webhookKey?: string | null;
}) {
  return new DodoPayments({
    bearerToken: input.apiKey,
    webhookKey: input.webhookKey ?? null,
    environment: input.environment,
    timeout: 15_000,
    maxRetries: 1,
  });
}

export async function dodoApiKeyFingerprint(apiKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getDodoCreatorPaymentAccount(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", DODO_CREATOR_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data || null) as DodoCreatorPaymentAccount | null;
}

export function dodoEnvironmentForAccount(account: DodoCreatorPaymentAccount) {
  return account.provider_metadata?.environment === "live_mode" ? "live_mode" : "test_mode";
}

export async function dodoClientForCreatorAccount(account: DodoCreatorPaymentAccount) {
  if (!account.access_token_ciphertext) throw new Error("Dodo credentials are incomplete.");
  return createDodoCreatorClient({
    apiKey: await decryptServerSecret(account.access_token_ciphertext),
    environment: dodoEnvironmentForAccount(account),
  });
}

export async function dodoWebhookClientForCreatorAccount(account: DodoCreatorPaymentAccount) {
  if (!account.webhook_secret_ciphertext) throw new Error("Dodo webhook is not configured.");
  return createDodoCreatorClient({
    apiKey: "webhook-verification-only",
    environment: dodoEnvironmentForAccount(account),
    webhookKey: await decryptServerSecret(account.webhook_secret_ciphertext),
  });
}
