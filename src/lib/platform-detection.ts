import { findPlatform, PLATFORMS, type PlatformDef } from "@/lib/platforms";
import { safeNavigationHref } from "@/lib/safe-url";

// Extract the first non-empty path segment, stripping a leading "@".
const firstSeg = (u: URL) => (u.pathname.split("/").filter(Boolean)[0] ?? "").replace(/^@/, "");

type PlatformHostMatch = {
  test: RegExp;
  key: string;
  extract?: (u: URL) => string;
};

export const PLATFORM_HOST_MAP: PlatformHostMatch[] = [
  // Social
  { test: /(^|\.)instagram\.com$/i, key: "instagram", extract: firstSeg },
  {
    test: /(^|\.)linkedin\.com$/i,
    key: "linkedin",
    extract: (u) => u.pathname.split("/").filter(Boolean)[1] ?? firstSeg(u),
  },
  { test: /(^|\.)(twitter|x)\.com$/i, key: "twitter", extract: firstSeg },
  { test: /(^|\.)tiktok\.com$/i, key: "tiktok", extract: firstSeg },
  { test: /(^|\.)facebook\.com$/i, key: "facebook", extract: firstSeg },
  { test: /(^|\.)threads\.net$/i, key: "threads", extract: firstSeg },
  { test: /(^|\.)pinterest\.com$/i, key: "pinterest", extract: firstSeg },
  {
    test: /(^|\.)reddit\.com$/i,
    key: "reddit",
    extract: (u) => u.pathname.match(/\/(?:user|r)\/([^/]+)/i)?.[1] ?? firstSeg(u),
  },
  {
    test: /(^|\.)snapchat\.com$/i,
    key: "snapchat",
    extract: (u) => u.pathname.match(/\/add\/([^/]+)/i)?.[1] ?? firstSeg(u),
  },
  {
    test: /(^|\.)bsky\.app$/i,
    key: "bluesky",
    extract: (u) => u.pathname.match(/\/profile\/([^/]+)/i)?.[1] ?? firstSeg(u),
  },
  { test: /(^|\.)mastodon\.(social|online|world|cloud)$/i, key: "mastodon", extract: firstSeg },
  { test: /(^|\.)discord\.(gg|com)$/i, key: "discord", extract: firstSeg },
  { test: /(^|\.)t\.me$/i, key: "telegram", extract: firstSeg },
  { test: /(^|\.)(wa\.me|whatsapp\.com)$/i, key: "whatsapp", extract: firstSeg },

  // Video
  {
    test: /(^|\.)(youtube\.com|youtu\.be)$/i,
    key: "youtube",
    extract: (u) => {
      const parts = u.pathname.split("/").filter(Boolean);
      if ((parts[0] === "channel" || parts[0] === "c" || parts[0] === "user") && parts[1]) {
        return parts[1];
      }
      return firstSeg(u);
    },
  },
  { test: /(^|\.)vimeo\.com$/i, key: "vimeo", extract: firstSeg },
  { test: /(^|\.)twitch\.tv$/i, key: "twitch", extract: firstSeg },
  { test: /(^|\.)loom\.com$/i, key: "loom", extract: firstSeg },

  // Music
  { test: /(^|\.)(open\.spotify\.com|spotify\.com)$/i, key: "spotify", extract: firstSeg },
  { test: /(^|\.)music\.apple\.com$/i, key: "apple_music", extract: firstSeg },
  { test: /(^|\.)soundcloud\.com$/i, key: "soundcloud", extract: firstSeg },
  { test: /(^|\.)bandcamp\.com$/i, key: "bandcamp", extract: firstSeg },

  // Dev
  { test: /(^|\.)github\.com$/i, key: "github", extract: firstSeg },
  { test: /(^|\.)gitlab\.com$/i, key: "gitlab", extract: firstSeg },
  {
    test: /(^|\.)stackoverflow\.com$/i,
    key: "stackoverflow",
    extract: (u) => u.pathname.match(/\/users\/(\d+)/i)?.[1] ?? firstSeg(u),
  },
  { test: /(^|\.)codepen\.io$/i, key: "codepen", extract: firstSeg },
  { test: /(^|\.)producthunt\.com$/i, key: "producthunt", extract: firstSeg },

  // Design
  { test: /(^|\.)dribbble\.com$/i, key: "dribbble", extract: firstSeg },
  { test: /(^|\.)behance\.(net|com)$/i, key: "behance", extract: firstSeg },
  { test: /(^|\.)figma\.com$/i, key: "figma", extract: firstSeg },

  // Writing
  { test: /(^|\.)medium\.com$/i, key: "medium", extract: firstSeg },
  {
    test: /\.substack\.com$/i,
    key: "substack",
    extract: (u) => u.hostname.replace(/\.substack\.com$/i, ""),
  },
  { test: /(^|\.)dev\.to$/i, key: "devto", extract: firstSeg },
  { test: /(^|\.)notion\.(so|site)$/i, key: "notion", extract: firstSeg },

  // Shop / pay
  { test: /(^|\.)gumroad\.com$/i, key: "gumroad", extract: firstSeg },
  {
    test: /(^|\.)etsy\.com$/i,
    key: "etsy",
    extract: (u) => u.pathname.match(/\/shop\/([^/]+)/i)?.[1] ?? firstSeg(u),
  },
  { test: /(^|\.)ko-fi\.com$/i, key: "kofi", extract: firstSeg },
  { test: /(^|\.)buymeacoffee\.com$/i, key: "bmac", extract: firstSeg },
  { test: /(^|\.)paypal\.me$/i, key: "paypal", extract: firstSeg },
  { test: /(^|\.)patreon\.com$/i, key: "patreon", extract: firstSeg },

  // Contact / scheduling
  { test: /(^|\.)calendly\.com$/i, key: "calendly", extract: firstSeg },
  { test: /(^|\.)savvycal\.com$/i, key: "savvycal", extract: firstSeg },
];

export function detectPlatformFromUrl(
  raw: string,
): { platform: PlatformDef; handle: string; hostname: string } | null {
  try {
    const u = new URL(raw);
    for (const match of PLATFORM_HOST_MAP) {
      if (match.test.test(u.hostname)) {
        const platform = PLATFORMS.find((p) => p.key === match.key);
        if (!platform) continue;
        const handle = (match.extract?.(u) ?? "").trim();
        const hostname = u.hostname.replace(/^www\./i, "");
        return { platform, handle: handle || hostname, hostname };
      }
    }
  } catch {
    // Invalid or incomplete URLs are not platform links.
  }
  return null;
}

const DIRECT_SOCIAL_URL = /^(https?:\/\/|www\.)/i;
const TRACKING_PARAMS = new Set(["hl", "s", "lang"]);

function knownPlatformHost(hostname: string) {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  return PLATFORM_HOST_MAP.some((match) => match.test.test(host));
}

/** A full URL, a www host, or a bare known platform host. Dotted handles stay handles. */
function absoluteHttpUrl(value: string) {
  const trimmed = value.trim();
  let candidate: string | null = null;
  if (/^https?:\/\//i.test(trimmed)) candidate = trimmed;
  else if (/^www\./i.test(trimmed)) candidate = `https://${trimmed}`;
  else {
    const host = trimmed.split(/[/?#]/)[0]?.replace(/:\d+$/, "") ?? "";
    if (host && !host.includes("@") && knownPlatformHost(host)) candidate = `https://${trimmed}`;
  }
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function withoutTrackingParams(absolute: string) {
  const url = new URL(absolute);
  for (const key of [...url.searchParams.keys()]) {
    const name = key.toLowerCase();
    if (TRACKING_PARAMS.has(name) || name.startsWith("utm_")) url.searchParams.delete(key);
  }
  return url.toString();
}

/** Host, path, and query with www and a trailing slash folded away. */
function profileUrlKey(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname
      .replace(/^www\./i, "")
      .replace(/^twitter\.com$/i, "x.com")
      .toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const search = [...url.searchParams.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${key}=${item}`)
      .join("&");
    return `${host}${path}${search ? `?${search}` : ""}`;
  } catch {
    return null;
  }
}

function sameProfileUrl(left: string, right: string) {
  const key = profileUrlKey(left);
  return key !== null && key === profileUrlKey(right);
}

/**
 * Shorten only when urlBase + handle rebuilds this exact profile.
 * Anything else (profile.php, /groups, /channel, /company, /u, invites) stays a full URL.
 */
function shortenProfileUrl(absolute: string) {
  const detected = detectPlatformFromUrl(absolute);
  if (!detected?.platform.urlBase || detected.platform.blockType !== "social_link") return null;
  const handle = detected.handle.replace(/^@/, "").trim().slice(0, 100);
  if (!handle || /[/?#]/.test(handle)) return null;
  const rebuilt = `${detected.platform.urlBase}${handle}`;
  if (!sameProfileUrl(absolute, rebuilt)) return null;
  return { platform: detected.platform.key, handle };
}

/** Turn a pasted profile URL into a handle only when that handle rebuilds the same URL. */
export function normalizeStoredSocialLink(platform: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { platform, handle: "" };
  const absolute = absoluteHttpUrl(trimmed);
  if (absolute) {
    const shortened = shortenProfileUrl(withoutTrackingParams(absolute));
    if (shortened) return shortened;
    return { platform, handle: absolute.slice(0, 2_048) };
  }
  if (/^https?:\/\//i.test(trimmed) || /^[^\s/@]+:\d+(?:\/|$)/.test(trimmed)) {
    return { platform, handle: "" };
  }
  return {
    platform,
    handle: trimmed
      .replace(/^@/, "")
      .replace(/[/?#].*$/, "")
      .trim()
      .slice(0, 100),
  };
}

/** Use a stored full URL as the link. Otherwise prefix the platform base. */
export function socialProfileHref(
  platformKey: string,
  handle?: string | null,
  explicitUrl?: string | null,
) {
  const explicit = explicitUrl?.trim();
  if (explicit) return safeNavigationHref(explicit);
  const raw = handle?.trim() ?? "";
  const platform = findPlatform(platformKey);
  if (raw && DIRECT_SOCIAL_URL.test(raw)) {
    return safeNavigationHref(/^www\./i.test(raw) ? `https://${raw}` : raw);
  }
  if (raw && platform?.urlBase) {
    return safeNavigationHref(`${platform.urlBase}${raw.replace(/^@/, "")}`);
  }
  return platform?.urlBase ? safeNavigationHref(platform.urlBase) : null;
}
