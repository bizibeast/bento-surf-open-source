import { describe, expect, it } from "vitest";
import { createFeaturebaseJwt, resolveFeaturebaseName } from "./featurebase.server";

function decodePart(part: string) {
  const base64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(base64));
}

describe("createFeaturebaseJwt", () => {
  it("creates a signed one-hour HS256 identity token", async () => {
    const token = await createFeaturebaseJwt(
      { userId: "user-123", email: " Creator@Example.com ", name: "Ada" },
      "featurebase-test-secret-with-enough-entropy",
      1_700_000_000,
    );
    const [header, payload, signature] = token.split(".");

    expect(decodePart(header)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decodePart(payload)).toEqual({
      userId: "user-123",
      email: "creator@example.com",
      name: "Ada",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("featurebase-test-secret-with-enough-entropy"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBytes = Uint8Array.from(
      atob(
        signature
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(signature.length / 4) * 4, "="),
      ),
      (character) => character.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });
});

describe("resolveFeaturebaseName", () => {
  it("uses the canonical Bento username before other identity fields", () => {
    expect(
      resolveFeaturebaseName({
        username: "bizibeast",
        displayName: "Ada Lovelace",
        metadataFullName: "OAuth Name",
        metadataName: "Auth Name",
        email: "creator@example.com",
      }),
    ).toBe("bizibeast");
  });

  it("falls back through display name, auth metadata, and email handle", () => {
    expect(
      resolveFeaturebaseName({
        username: " ",
        displayName: " Ada Lovelace ",
        metadataFullName: "OAuth Name",
        email: "creator@example.com",
      }),
    ).toBe("Ada Lovelace");

    expect(
      resolveFeaturebaseName({
        metadataFullName: " OAuth Name ",
        email: "creator@example.com",
      }),
    ).toBe("OAuth Name");

    expect(resolveFeaturebaseName({ email: " creator@example.com " })).toBe("creator");
  });
});
