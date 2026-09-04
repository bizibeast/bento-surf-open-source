import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Private payment columns are added by a pending migration. */
import { Polar } from "@polar-sh/sdk";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret, encryptServerSecret } from "@/lib/secret-crypto.server";

export const POLAR_PROVIDER = "polar";
export const POLAR_SCOPES = [
  "openid",
  "organizations:read",
  "products:write",
  "checkouts:write",
  "webhooks:write",
] as const;
export const POLAR_WEBHOOK_EVENTS = [
  "order.paid",
  "order.refunded",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.past_due",
  "subscription.revoked",
] as const;

export type PolarPaymentAccount = {
  id: string;
  creator_id: string;
  provider_account_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  token_expires_at: string | null;
  webhook_endpoint_id: string | null;
  webhook_secret_ciphertext: string | null;
  provider_metadata: Record<string, unknown> | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
};

export function polarOrganizationReadiness(organization: {
  capabilities: { checkoutPayments: boolean; payouts: boolean };
  detailsSubmittedAt: Date | null;
  status: string;
}) {
  const chargesEnabled = organization.capabilities.checkoutPayments;
  const payoutsEnabled = organization.capabilities.payouts;
  const detailsSubmitted = Boolean(organization.detailsSubmittedAt);
  return {
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    onboardingStatus:
      chargesEnabled && payoutsEnabled && detailsSubmitted && organization.status === "active"
        ? "complete"
        : "pending",
  };
}

function polarEnvironment() {
  return process.env.POLAR_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
}

export function polarWebBaseUrl() {
  return polarEnvironment() === "sandbox" ? "https://sandbox.polar.sh" : "https://polar.sh";
}

function polarApiBaseUrl() {
  return polarEnvironment() === "sandbox"
    ? "https://sandbox-api.polar.sh/v1"
    : "https://api.polar.sh/v1";
}

export function polarRedirectUri() {
  const origin = configuredAppOrigin(process.env.VITE_APP_URL);
  return `${origin}/integrations/polar/callback`;
}

function oauthCredentials() {
  const clientId = process.env.POLAR_CLIENT_ID?.trim();
  const clientSecret = process.env.POLAR_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Polar OAuth is not configured.");
  return { clientId, clientSecret };
}

export function polarAuthorizeUrl(state: string) {
  const { clientId } = oauthCredentials();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: polarRedirectUri(),
    scope: POLAR_SCOPES.join(" "),
    state,
  });
  return `${polarWebBaseUrl()}/oauth2/authorize?${query}`;
}

type PolarTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

async function tokenRequest(parameters: Record<string, string>) {
  const { clientId, clientSecret } = oauthCredentials();
  const response = await fetch(`${polarApiBaseUrl()}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...parameters,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as PolarTokenResponse & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description || payload.error || "Polar rejected the OAuth request.",
    );
  }
  return payload;
}

export function exchangePolarCode(code: string) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: polarRedirectUri(),
  });
}

async function refreshPolarToken(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export function createPolarClient(accessToken: string) {
  return new Polar({
    accessToken,
    server: polarEnvironment(),
  });
}

export async function getPolarPaymentAccount(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", POLAR_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as PolarPaymentAccount | null;
}

export async function getValidPolarAccessToken(account: PolarPaymentAccount) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60_000) {
    return decryptServerSecret(account.access_token_ciphertext);
  }
  if (!account.refresh_token_ciphertext) throw new Error("Reconnect Polar to renew access.");
  const refreshed = await refreshPolarToken(
    await decryptServerSecret(account.refresh_token_ciphertext),
  );
  const accessCiphertext = await encryptServerSecret(refreshed.access_token);
  const refreshCiphertext = refreshed.refresh_token
    ? await encryptServerSecret(refreshed.refresh_token)
    : account.refresh_token_ciphertext;
  const tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1_000).toISOString();
  const { error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .update({
      access_token_ciphertext: accessCiphertext,
      refresh_token_ciphertext: refreshCiphertext,
      token_expires_at: tokenExpiresAt,
      scopes: refreshed.scope.split(/\s+/).filter(Boolean),
    })
    .eq("id", account.id);
  if (error) throw new Error(error.message);
  return refreshed.access_token;
}

export async function polarClientForAccount(account: PolarPaymentAccount) {
  return createPolarClient(await getValidPolarAccessToken(account));
}
