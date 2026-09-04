import { afterEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc },
}));

import {
  handleInstagramDataDeletionStatusRequest,
  handleInstagramDataRequest,
  verifyInstagramSignedRequest,
} from "./data-requests.server";

const originalEnv = process.env;

function encodeBase64Url(bytes: Uint8Array | string) {
  const value = typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...bytes));
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createSignedRequest(
  appSecret: string,
  payload: Record<string, unknown> = {
    algorithm: "HMAC-SHA256",
    user_id: "instagram-account-123",
  },
) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload)),
  );
  return `${encodeBase64Url(signature)}.${encodedPayload}`;
}

function deletionRequest(signedRequest: string) {
  return new Request("https://app.bento.surf/api/integrations/instagram/data-deletion", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: signedRequest }),
  });
}

afterEach(() => {
  process.env = originalEnv;
  rpc.mockReset();
});

describe("Meta Instagram data requests", () => {
  it("accepts only an authentic HMAC-SHA256 signed request", async () => {
    const signedRequest = await createSignedRequest("meta-app-secret");
    await expect(verifyInstagramSignedRequest(signedRequest, "meta-app-secret")).resolves.toBe(
      "instagram-account-123",
    );
    await expect(
      verifyInstagramSignedRequest(signedRequest, "different-secret"),
    ).resolves.toBeNull();
  });

  it("atomically purges account data and returns a persisted confirmation URL", async () => {
    process.env = {
      ...originalEnv,
      META_INSTAGRAM_APP_SECRET: "meta-app-secret",
      VITE_APP_URL: "https://app.bento.surf",
    };
    rpc.mockResolvedValue({
      data: "2026-07-30T12:00:00.000Z",
      error: null,
    });

    const response = await handleInstagramDataRequest(
      deletionRequest(await createSignedRequest("meta-app-secret")),
      "delete",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      url: string;
      confirmation_code: string;
    };
    expect(body.url).toBe(
      `https://app.bento.surf/integrations/instagram/data-deletion?code=${body.confirmation_code}`,
    );
    expect(rpc).toHaveBeenCalledWith(
      "purge_instagram_account_data",
      expect.objectContaining({
        p_provider_user_id: "instagram-account-123",
        p_provider_user_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        p_confirmation_code: body.confirmation_code,
      }),
    );
  });

  it("reports a completed deletion only when the confirmation exists", async () => {
    const confirmationCode = "e32a71b7-4f2d-4bf2-9500-8d8c28144b72";
    rpc.mockResolvedValueOnce({
      data: [{ completed_at: "2026-07-30T12:00:00.000Z" }],
      error: null,
    });
    const completed = await handleInstagramDataDeletionStatusRequest(
      new Request(
        `https://app.bento.surf/api/integrations/instagram/data-deletion/status?code=${confirmationCode}`,
      ),
    );
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      status: "completed",
      completedAt: "2026-07-30T12:00:00.000Z",
    });

    const invalid = await handleInstagramDataDeletionStatusRequest(
      new Request(
        "https://app.bento.surf/api/integrations/instagram/data-deletion/status?code=not-a-code",
      ),
    );
    expect(invalid.status).toBe(404);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
