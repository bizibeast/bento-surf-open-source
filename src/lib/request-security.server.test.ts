import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforceRequestRateLimit,
  enforceServerFunctionRequestLimits,
  enforceTurnstileRequest,
  readRequestText,
  readResponseBytes,
  RequestBodyTooLargeError,
} from "./request-security.server";
import { TURNSTILE_ACTION, TURNSTILE_TOKEN_HEADER } from "./turnstile";

afterEach(() => vi.unstubAllGlobals());

describe("request rate limits", () => {
  it("raises an HTTP 429 error when the shared limiter rejects a request", async () => {
    vi.stubGlobal("__env__", {
      PUBLIC_API_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
    });

    await expect(
      enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "test", "attacker"),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("fails closed when a deployed limiter binding is missing", async () => {
    vi.stubGlobal("__env__", { APP_ENV: "production" });

    await expect(
      enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "test", "attacker"),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("Turnstile request verification", () => {
  const verifierUrl = "https://verify.example.com/turnstile";
  const protectedRequest = (hostname = "app.example.com") =>
    new Request(`https://${hostname}/api/public-form`, {
      method: "POST",
      headers: {
        [TURNSTILE_TOKEN_HEADER]: "valid-turnstile-token",
        "cf-connecting-ip": "203.0.113.10",
      },
    });

  it("passes the token and visitor IP to the verifier and accepts the matching action and host", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        success: true,
        action: TURNSTILE_ACTION,
        hostname: "app.example.com",
      }),
    );

    await expect(
      enforceTurnstileRequest(
        protectedRequest(),
        { APP_ENV: "production", TURNSTILE_VERIFIER_URL: verifierUrl },
        fetcher as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(verifierUrl);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      token: "valid-turnstile-token",
      idempotency_key: expect.any(String),
      remoteip: "203.0.113.10",
    });
  });

  it.each([
    ["failed challenge", { success: false, action: TURNSTILE_ACTION, hostname: "app.example.com" }],
    ["wrong action", { success: true, action: "other-action", hostname: "app.example.com" }],
    ["wrong hostname", { success: true, action: TURNSTILE_ACTION, hostname: "other.example.com" }],
  ])("rejects a %s", async (_label, verification) => {
    const fetcher = vi.fn(async () => Response.json(verification));

    await expect(
      enforceTurnstileRequest(
        protectedRequest(),
        { APP_ENV: "production", TURNSTILE_VERIFIER_URL: verifierUrl },
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("fails closed when deployed configuration or the verifier is unavailable", async () => {
    await expect(
      enforceTurnstileRequest(protectedRequest(), { APP_ENV: "preview" }),
    ).rejects.toMatchObject({ statusCode: 503 });

    await expect(
      enforceTurnstileRequest(protectedRequest(), { APP_ENV: "staging" }),
    ).rejects.toMatchObject({ statusCode: 503 });

    await expect(
      enforceTurnstileRequest(
        protectedRequest(),
        { APP_ENV: "staging", TURNSTILE_VERIFIER_URL: verifierUrl },
        vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects a missing token and a verifier network failure", async () => {
    await expect(
      enforceTurnstileRequest(new Request("https://self.example/api/public-form"), {
        APP_ENV: "production",
        TURNSTILE_VERIFIER_URL: verifierUrl,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      enforceTurnstileRequest(
        new Request("https://self.example/api/public-form", {
          headers: { [TURNSTILE_TOKEN_HEADER]: "x".repeat(2_049) },
        }),
        { APP_ENV: "production", TURNSTILE_VERIFIER_URL: verifierUrl },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      enforceTurnstileRequest(
        protectedRequest(),
        { APP_ENV: "production", TURNSTILE_VERIFIER_URL: verifierUrl },
        vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("does not require Turnstile outside staging and production", async () => {
    const fetcher = vi.fn();

    await expect(
      enforceTurnstileRequest(
        new Request("http://localhost:8080/api/public-form"),
        { APP_ENV: "development" },
        fetcher,
      ),
    ).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("server-function request limits", () => {
  it("rejects oversized chunked POST and GET payloads", async () => {
    const chunked = new Request("https://bento.surf/_serverFn/test", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(200 * 1024));
          controller.enqueue(new Uint8Array(200 * 1024));
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const oversizedGet = new Request(
      `https://bento.surf/_serverFn/test?payload=${"a".repeat(256 * 1024 + 1)}`,
    );

    await expect(enforceServerFunctionRequestLimits(chunked)).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(enforceServerFunctionRequestLimits(oversizedGet)).rejects.toMatchObject({
      statusCode: 413,
    });
  });
});

describe("bounded request and response readers", () => {
  it("rejects declared and chunked request bodies over the limit", async () => {
    const declared = new Request("https://bento.surf/api/test", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "small",
    });
    await expect(readRequestText(declared, 16)).rejects.toBeInstanceOf(RequestBodyTooLargeError);

    const chunked = new Request("https://bento.surf/api/test", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(12));
          controller.enqueue(new Uint8Array(12));
          controller.close();
        },
      }),
      // Required by Node's Request implementation for a streamed body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readRequestText(chunked, 16)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects responses that lie by omission about their size", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      }),
    );
    await expect(readResponseBytes(response, 12)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
