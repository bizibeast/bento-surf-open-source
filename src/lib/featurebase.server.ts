const encoder = new TextEncoder();

export type FeaturebaseIdentityPayload = {
  userId: string;
  email: string;
  name?: string;
};

export type FeaturebaseNameSources = {
  username?: unknown;
  displayName?: unknown;
  metadataFullName?: unknown;
  metadataName?: unknown;
  email: string;
};

export function resolveFeaturebaseName({
  username,
  displayName,
  metadataFullName,
  metadataName,
  email,
}: FeaturebaseNameSources) {
  const emailHandle = email.trim().split("@")[0];
  const candidates = [
    username,
    displayName,
    metadataFullName,
    metadataName,
    emailHandle,
    "Bento creator",
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 500);
    }
  }

  return "Bento creator";
}

function base64UrlEncode(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createFeaturebaseJwt(
  payload: FeaturebaseIdentityPayload,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) throw new Error("FEATUREBASE_JWT_SECRET is required.");

  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(
    JSON.stringify({
      userId: payload.userId,
      email: payload.email.trim().toLowerCase(),
      ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
      iat: nowSeconds,
      exp: nowSeconds + 60 * 60,
    }),
  );
  const unsignedToken = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalizedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedToken));
  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}
