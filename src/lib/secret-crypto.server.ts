const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexDecode(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("The connection encryption key must contain 64 hexadecimal characters.");
  }
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

export type SecretPurpose = "payment" | "social" | "booking";

function configuredKeyBytes(configured: string) {
  const explicitlyHex = configured.startsWith("hex:");
  const explicitlyBase64 = configured.startsWith("base64:");
  const normalized = explicitlyHex
    ? configured.slice(4)
    : explicitlyBase64
      ? configured.slice(7)
      : configured;
  const bytes =
    explicitlyHex || (!explicitlyBase64 && /^[a-f0-9]{64}$/i.test(normalized))
      ? hexDecode(normalized)
      : base64UrlDecode(normalized);
  if (bytes.byteLength !== 32) {
    throw new Error(
      "The connection encryption key must be a base64-encoded 32-byte key or a 64-character hexadecimal key.",
    );
  }
  return bytes;
}

export function isServerSecretEncryptionKeyValid(configured: unknown) {
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  if (!trimmed) return false;
  try {
    return configuredKeyBytes(trimmed).byteLength === 32;
  } catch {
    return false;
  }
}

function encryptionKeyBytes(purpose: SecretPurpose = "payment") {
  const environmentName =
    purpose === "social"
      ? "SOCIAL_CONNECTION_ENCRYPTION_KEY"
      : purpose === "booking"
        ? "BOOKING_CONNECTION_ENCRYPTION_KEY"
        : "PAYMENT_CONNECTION_ENCRYPTION_KEY";
  const configured = process.env[environmentName]?.trim();
  if (!configured) {
    throw new Error(`${environmentName} is not configured.`);
  }
  return configuredKeyBytes(configured);
}

async function encryptionKey(purpose: SecretPurpose = "payment") {
  return crypto.subtle.importKey("raw", encryptionKeyBytes(purpose), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptServerSecret(value: string, purpose: SecretPurpose = "payment") {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(purpose),
    textEncoder.encode(value),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptServerSecret(value: string, purpose: SecretPurpose = "payment") {
  const [version, encodedIv, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) {
    throw new Error("Unsupported encrypted secret format.");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encodedIv) },
    await encryptionKey(purpose),
    base64UrlDecode(encodedCiphertext),
  );
  return textDecoder.decode(plaintext);
}
