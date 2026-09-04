import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";
import { configuredAppOrigin } from "@/lib/application-urls";

type RpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

type InstagramDataDeletionRpcClient = {
  rpc(name: string, args: Record<string, string>): PromiseLike<RpcResult>;
};

const CONFIRMATION_CODE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashProviderUserId(providerUserId: string, appSecret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(providerUserId)));
}

export async function verifyInstagramSignedRequest(signedRequest: string, appSecret: string) {
  if (!signedRequest || signedRequest.length > 24_000) return null;
  const [encodedSignature, encodedPayload] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(encodedPayload),
  );
  if (!valid) return null;
  let payload: { algorithm?: string; user_id?: string | number };
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    ) as typeof payload;
  } catch {
    return null;
  }
  if (payload.algorithm?.toUpperCase() !== "HMAC-SHA256" || !payload.user_id) return null;
  return String(payload.user_id);
}

async function purgeInstagramAccountData(
  providerUserId: string,
  appSecret: string,
  confirmationCode: string,
) {
  const providerUserIdHash = await hashProviderUserId(providerUserId, appSecret);
  const client = supabaseAdmin as unknown as InstagramDataDeletionRpcClient;
  const { data, error } = await client.rpc("purge_instagram_account_data", {
    p_provider_user_id: providerUserId,
    p_provider_user_id_hash: providerUserIdHash,
    p_confirmation_code: confirmationCode,
  });
  return { completedAt: typeof data === "string" ? data : null, error };
}

export async function handleInstagramDataRequest(request: Request, mode: "deauthorize" | "delete") {
  const appSecret = process.env.META_INSTAGRAM_APP_SECRET?.trim();
  if (!appSecret) return new Response("Instagram integration is not configured", { status: 503 });
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new Response("Unsupported content type", { status: 415 });
  }
  let raw: string;
  try {
    raw = await readRequestText(request, 32_768);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    throw error;
  }
  const signedRequest = new URLSearchParams(raw).get("signed_request");
  if (!signedRequest) return new Response("Missing signed request", { status: 400 });
  const providerUserId = await verifyInstagramSignedRequest(signedRequest, appSecret).catch(
    () => null,
  );
  if (!providerUserId) return new Response("Invalid signed request", { status: 401 });

  const confirmationCode = crypto.randomUUID();
  const { completedAt, error } = await purgeInstagramAccountData(
    providerUserId,
    appSecret,
    confirmationCode,
  );
  if (error || !completedAt) {
    return new Response("Unable to remove Instagram data", { status: 500 });
  }
  if (mode === "deauthorize") {
    return Response.json({ success: true });
  }
  const appOrigin = configuredAppOrigin(process.env.VITE_APP_URL);
  return Response.json({
    url: `${appOrigin}/integrations/instagram/data-deletion?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
}

export async function handleInstagramDataDeletionStatusRequest(request: Request) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  const confirmationCode = new URL(request.url).searchParams.get("code")?.trim() ?? "";
  if (!CONFIRMATION_CODE_PATTERN.test(confirmationCode)) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }

  const client = supabaseAdmin as unknown as InstagramDataDeletionRpcClient;
  const { data, error } = await client.rpc("get_instagram_data_deletion_status", {
    p_confirmation_code: confirmationCode,
  });
  if (error) {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
  const row =
    Array.isArray(data) && typeof data[0]?.completed_at === "string"
      ? (data[0] as { completed_at: string })
      : null;
  if (!row) return Response.json({ status: "not_found" }, { status: 404 });

  return Response.json(
    { status: "completed", completedAt: row.completed_at },
    { headers: { "cache-control": "no-store" } },
  );
}
