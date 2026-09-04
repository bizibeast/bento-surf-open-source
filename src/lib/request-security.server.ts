import { createServerOnlyFn } from "@tanstack/react-start";
import { TURNSTILE_ACTION, TURNSTILE_TOKEN_HEADER } from "./turnstile";

const MAX_SERVER_FUNCTION_BODY_BYTES = 256 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestHttpError";
  }
}

export async function readRequestText(request: Request, maxBytes: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestBodyTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

export async function readResponseBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError();
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestBodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readResponseText(response: Response, maxBytes: number) {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}

export async function enforceServerFunctionRequestLimits(request: Request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_serverFn/")) return;
  if (request.method === "GET" || request.method === "HEAD") {
    if ((url.searchParams.get("payload")?.length ?? 0) > MAX_SERVER_FUNCTION_BODY_BYTES) {
      throw new RequestHttpError(413, "Request payload is too large");
    }
    return;
  }
  if (!request.body) return;

  try {
    await readRequestText(request.clone() as unknown as Request, MAX_SERVER_FUNCTION_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      await request.body.cancel(error).catch(() => undefined);
      throw new RequestHttpError(413, "Request payload is too large");
    }
    throw error;
  }
}

type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };
type SecurityEnv = {
  APP_ENV?: string;
  AUTH_EMAIL_RATE_LIMITER?: RateLimitBinding;
  CHECKOUT_RATE_LIMITER?: RateLimitBinding;
  PUBLIC_API_RATE_LIMITER?: RateLimitBinding;
  EXPENSIVE_API_RATE_LIMITER?: RateLimitBinding;
  UPLOAD_RATE_LIMITER?: RateLimitBinding;
};
type RateLimitBindingName = Exclude<keyof SecurityEnv, "APP_ENV">;

export type TurnstileEnv = {
  APP_ENV?: string;
  TURNSTILE_VERIFIER_URL?: string;
};

type TurnstileVerification = {
  success?: boolean;
  action?: string;
  hostname?: string;
};

const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;

const clientAddress = createServerOnlyFn(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed by an Internet
  // client. Do not use X-Forwarded-For as a fallback for a security decision.
  return request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
});

export async function enforceRequestRateLimit(
  binding: RateLimitBindingName,
  scope: string,
  explicitKey?: string,
) {
  const limiter = (globalThis.__env__ as SecurityEnv | undefined)?.[binding];
  if (!limiter) {
    const environment = (globalThis.__env__ as SecurityEnv | undefined)?.APP_ENV;
    if (environment === "production" || environment === "staging") {
      throw new RequestHttpError(503, "Security controls are temporarily unavailable");
    }
    return;
  }
  const key = `${scope}:${explicitKey || (await clientAddress())}`.slice(0, 512);
  const result = await limiter.limit({ key });
  if (!result.success) {
    throw new RequestHttpError(429, "Too many requests. Please wait a moment and try again.");
  }
}

export async function enforceTurnstileRequest(
  request: Request,
  env: TurnstileEnv,
  fetcher: typeof fetch = fetch,
) {
  const environment = env.APP_ENV ?? import.meta.env.MODE;
  if (environment === "development" || environment === "test") return;

  const token = request.headers.get(TURNSTILE_TOKEN_HEADER)?.trim();
  if (!token || token.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    throw new RequestHttpError(403, "Complete the security check and try again.");
  }

  const verifierUrl = env.TURNSTILE_VERIFIER_URL?.trim();
  if (!verifierUrl) {
    throw new RequestHttpError(503, "Security verification is temporarily unavailable.");
  }

  let response: Response;
  try {
    const remoteip = request.headers.get("cf-connecting-ip")?.trim();
    response = await fetcher(verifierUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        idempotency_key: crypto.randomUUID(),
        ...(remoteip ? { remoteip } : {}),
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new RequestHttpError(503, "Security verification is temporarily unavailable.");
  }

  if (!response.ok) {
    throw new RequestHttpError(503, "Security verification is temporarily unavailable.");
  }

  let verification: TurnstileVerification;
  try {
    verification = JSON.parse(await readResponseText(response, 16 * 1024)) as TurnstileVerification;
  } catch {
    throw new RequestHttpError(503, "Security verification is temporarily unavailable.");
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  if (
    verification.success !== true ||
    verification.action !== TURNSTILE_ACTION ||
    verification.hostname?.toLowerCase() !== hostname
  ) {
    throw new RequestHttpError(403, "Complete the security check and try again.");
  }
}

export const enforceCurrentRequestTurnstile = createServerOnlyFn(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  await enforceTurnstileRequest(
    getRequest(),
    (globalThis.__env__ ?? {}) as unknown as TurnstileEnv,
  );
});
