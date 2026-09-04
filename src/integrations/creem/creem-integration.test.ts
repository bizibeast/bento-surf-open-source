import { afterEach, describe, expect, it, vi } from "vitest";
import {
  creemApiBase,
  assertCreemEnvironment,
  creemCredentialFingerprint,
  creemRequest,
  creemWebhookUrl,
  CREEM_WEBHOOK_EVENTS,
  verifyCreemWebhookSignature,
} from "./client.server";
import { creemSupportsCommerceKind } from "./checkout.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Creem creator payments", () => {
  it("subscribes to Creem's available dispute opening event", () => {
    expect(CREEM_WEBHOOK_EVENTS).toContain("dispute.created");
  });

  it("keeps test and production APIs isolated", () => {
    expect(creemApiBase("test")).toBe("https://test-api.creem.io");
    expect(creemApiBase("production")).toBe("https://api.creem.io");
  });

  it("sends the secret only in the x-api-key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], pagination: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await creemRequest("private-creem-key", "test", "/v1/store/search?page_size=1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test-api.creem.io/v1/store/search?page_size=1");
    expect(new Headers(init.headers).get("x-api-key")).toBe("private-creem-key");
    expect(url).not.toContain("private-creem-key");
    expect(init.body).toBeUndefined();
  });

  it("uses stable, environment-scoped credential fingerprints", async () => {
    const first = await creemCredentialFingerprint("creem-key-for-testing", "test");
    const second = await creemCredentialFingerprint("creem-key-for-testing", "test");
    const production = await creemCredentialFingerprint("creem-key-for-testing", "production");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(production).not.toBe(first);
  });

  it("builds the per-creator webhook URL from the deployment origin", () => {
    vi.stubEnv("VITE_APP_URL", "https://staging.example/");
    expect(creemWebhookUrl("00000000-0000-4000-8000-000000000001")).toBe(
      "https://staging.example/api/webhooks/creem/direct/00000000-0000-4000-8000-000000000001",
    );
  });

  it.each(["development", "preview", "staging"])(
    "keeps live credentials out of non-production %s",
    (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      expect(() => assertCreemEnvironment("production")).toThrow(
        /Live keys are blocked outside production/,
      );
      expect(assertCreemEnvironment("test")).toBe("test");
    },
  );

  it("verifies raw-body HMAC signatures and rejects tampering", async () => {
    const raw = JSON.stringify({ id: "evt_1", eventType: "checkout.completed" });
    const secret = "creem-webhook-secret-for-tests";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const signature = Array.from(new Uint8Array(signed), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(await verifyCreemWebhookSignature(raw, signature, secret)).toBe(true);
    expect(await verifyCreemWebhookSignature(`${raw} `, signature, secret)).toBe(false);
  });

  it("limits Creem to eligible digital commerce kinds", () => {
    expect(creemSupportsCommerceKind("digital_product")).toBe(true);
    expect(creemSupportsCommerceKind("course")).toBe(true);
    expect(creemSupportsCommerceKind("webinar")).toBe(false);
    expect(creemSupportsCommerceKind("paid_community")).toBe(false);
    expect(creemSupportsCommerceKind("membership")).toBe(false);
    expect(creemSupportsCommerceKind("coaching_call")).toBe(false);
    expect(creemSupportsCommerceKind("custom_product")).toBe(false);
  });
});
