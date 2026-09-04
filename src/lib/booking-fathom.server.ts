import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Fathom SDK payloads are normalized here. */
import { Fathom } from "fathom-typescript";
import type { TokenStore } from "fathom-typescript/funcs/withAuthorization.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret, encryptServerSecret } from "./secret-crypto.server";

function appOrigin() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

export function fathomRedirectUri() {
  return `${appOrigin()}/integrations/fathom/callback`;
}

function credentials() {
  const clientId = process.env.FATHOM_CLIENT_ID?.trim();
  const clientSecret = process.env.FATHOM_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || !process.env.BOOKING_CONNECTION_ENCRYPTION_KEY) {
    throw new Error("Fathom is awaiting Bento's secure OAuth app configuration.");
  }
  return { clientId, clientSecret };
}

export function fathomReady() {
  try {
    credentials();
    return true;
  } catch {
    return false;
  }
}

export function fathomAuthorizationUrl(state: string) {
  const { clientId, clientSecret } = credentials();
  return Fathom.getAuthorizationUrl({
    clientId,
    clientSecret,
    redirectUri: fathomRedirectUri(),
    scope: "public_api",
    state,
  });
}

type StoredTokens = { token: string; refresh_token: string; expires: number };

class CaptureTokenStore implements TokenStore {
  value: StoredTokens | undefined;

  async get() {
    return this.value ?? { token: "", refresh_token: "", expires: Date.now() };
  }

  async set(token: string, refresh_token: string, expires: number) {
    this.value = { token, refresh_token, expires };
  }
}

class DatabaseTokenStore implements TokenStore {
  constructor(private connection: any) {}

  async get() {
    return {
      token: await decryptServerSecret(this.connection.access_token_ciphertext, "booking"),
      refresh_token: await decryptServerSecret(this.connection.refresh_token_ciphertext, "booking"),
      expires: new Date(this.connection.token_expires_at).getTime(),
    };
  }

  async set(token: string, refreshToken: string, expires: number) {
    const update = {
      access_token_ciphertext: await encryptServerSecret(token, "booking"),
      // Fathom refresh tokens rotate and are single-use, so this update must be atomic.
      refresh_token_ciphertext: await encryptServerSecret(refreshToken, "booking"),
      token_expires_at: new Date(expires).toISOString(),
      status: "active",
      last_error: null,
    };
    const { error } = await (supabaseAdmin as any)
      .from("booking_fathom_connections")
      .update(update)
      .eq("id", this.connection.id);
    if (error) throw new Error("Fathom access could not be renewed.");
    Object.assign(this.connection, update);
  }
}

function fathomClient(code: string, store: TokenStore) {
  const { clientId, clientSecret } = credentials();
  return new Fathom({
    security: Fathom.withAuthorization({
      clientId,
      clientSecret,
      code,
      redirectUri: fathomRedirectUri(),
      tokenStore: store,
    }),
  });
}

async function firstMeeting(client: Fathom) {
  const pages = await client.listMeetings({
    createdAfter: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    createdBefore: new Date(Date.now() + 86_400_000).toISOString(),
  });
  for await (const page of pages) return page.result.items[0] ?? null;
  return null;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function exchangeFathomCode(code: string) {
  const store = new CaptureTokenStore();
  const client = fathomClient(code, store);
  const meeting = await firstMeeting(client);
  if (!store.value) throw new Error("Fathom did not return a reusable connection.");
  const identity = meeting?.recordedBy;
  return {
    tokens: store.value,
    providerUserId: identity?.email?.toLowerCase() || (await sha256(store.value.refresh_token)),
    email: identity?.email?.toLowerCase() || null,
    displayName: identity?.name || null,
  };
}

export async function listFathomMeetings(
  connection: any,
  input: {
    createdAfter: Date;
    createdBefore: Date;
  },
) {
  const client = fathomClient("stored-connection", new DatabaseTokenStore(connection));
  const pages = await client.listMeetings({
    createdAfter: input.createdAfter.toISOString(),
    createdBefore: input.createdBefore.toISOString(),
  });
  const meetings: any[] = [];
  for await (const page of pages) {
    meetings.push(...page.result.items);
    if (meetings.length >= 100) break;
  }
  return meetings.slice(0, 100);
}
