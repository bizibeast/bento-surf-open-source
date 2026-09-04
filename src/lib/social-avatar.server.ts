import { getMediaBucket, mediaObjectUrl } from "./r2-storage.server";
import { readResponseBytes } from "./request-security.server";
import type { SocialProvider } from "./social-scheduler";
import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_HOSTS: Record<SocialProvider, readonly string[]> = {
  instagram: ["cdninstagram.com", "fbcdn.net"],
  facebook: ["fbcdn.net"],
  threads: ["cdninstagram.com", "fbcdn.net"],
  tiktok: ["tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "ibytedtos.com"],
  linkedin: ["licdn.com"],
  twitter: ["twimg.com"],
  youtube: ["ggpht.com", "googleusercontent.com"],
  reddit: ["redditstatic.com", "redditmedia.com", "redd.it"],
};

function allowedAvatarUrl(provider: SocialProvider, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return AVATAR_HOSTS[provider].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
      ? url
      : null;
  } catch {
    return null;
  }
}

function bentoAvatarHosts() {
  return new Set([
    new URL(configuredAppOrigin(process.env.VITE_APP_URL)).hostname,
    new URL(configuredPublicOrigin(process.env.VITE_PUBLIC_URL)).hostname,
  ]);
}

function isBentoAvatar(value: string) {
  try {
    const url = new URL(value);
    return bentoAvatarHosts().has(url.hostname) && url.pathname.startsWith("/cdn/users/");
  } catch {
    return false;
  }
}

function avatarContentType(contentType: string, bytes: Uint8Array) {
  if (contentType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return contentType;
  if (
    contentType === "image/png" &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return contentType;
  if (
    contentType === "image/webp" &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return contentType;
  return null;
}

async function downloadAvatar(provider: SocialProvider, value: string) {
  let url = allowedAvatarUrl(provider, value);
  for (let redirects = 0; url && redirects <= 2; redirects += 1) {
    const response = await fetch(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "image/webp,image/png,image/jpeg" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      url = location ? allowedAvatarUrl(provider, new URL(location, url).toString()) : null;
      continue;
    }
    if (!response.ok) return null;
    const bytes = await readResponseBytes(response, MAX_AVATAR_BYTES).catch(() => null);
    if (!bytes?.length) return null;
    const contentType = avatarContentType(
      response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || "",
      bytes,
    );
    return contentType ? { bytes, contentType } : null;
  }
  return null;
}

export async function durableSocialAvatarUrl(input: {
  userId: string;
  provider: SocialProvider;
  providerUserId: string;
  value?: string | null;
}) {
  if (!input.value || isBentoAvatar(input.value)) return input.value || null;
  try {
    const avatar = await downloadAvatar(input.provider, input.value);
    if (!avatar) return input.value;
    const [identityDigest, contentDigest] = await Promise.all([
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${input.provider}:${input.providerUserId}`),
      ),
      crypto.subtle.digest("SHA-256", avatar.bytes),
    ]);
    const hash = [...new Uint8Array(identityDigest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const contentHash = [...new Uint8Array(contentDigest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const key = `users/${input.userId}/social-avatars/${input.provider}-${hash}-${contentHash}`;
    await getMediaBucket().put(key, avatar.bytes, {
      httpMetadata: {
        contentType: avatar.contentType,
        cacheControl: "public, max-age=86400, stale-while-revalidate=604800",
      },
      customMetadata: { provider: input.provider, providerUserId: input.providerUserId },
    });
    return mediaObjectUrl(key, process.env.VITE_APP_URL);
  } catch (error) {
    console.warn("Social avatar copy failed", {
      provider: input.provider,
      message: error instanceof Error ? error.message : "unknown",
    });
    return input.value;
  }
}
