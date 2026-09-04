import { PLATFORMS, type PlatformDef } from "@/lib/platforms";

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
  { test: /(^|\.)(youtube\.com|youtu\.be)$/i, key: "youtube", extract: firstSeg },
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
