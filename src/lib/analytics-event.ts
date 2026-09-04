import { z } from "zod";

export const analyticsEventInputSchema = z
  .object({
    event_id: z.string().uuid(),
    kind: z.enum(["view", "click"]),
    user_id: z.string().uuid(),
    block_id: z.string().uuid().optional(),
    visitor_hash: z.string().max(64).optional(),
    referrer: z.string().max(512).optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "click" && !value.block_id) {
      context.addIssue({
        code: "custom",
        path: ["block_id"],
        message: "Click events require a block ID.",
      });
    }
  });

export type AnalyticsEventInput = z.infer<typeof analyticsEventInputSchema>;

export type AnalyticsEvent = AnalyticsEventInput & {
  user_agent: string | null;
  device: string;
  browser: string;
  country: string | null;
  city: string | null;
  source: string;
};

export function parseDevice(userAgent: string) {
  const normalized = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(normalized)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini/.test(normalized)) return "mobile";
  return "desktop";
}

export function parseBrowser(userAgent: string) {
  if (!userAgent) return "Unknown";
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/Chrome\//.test(userAgent) && !/Chromium/.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent) && !/Chrome/.test(userAgent)) return "Safari";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/MSIE |Trident\//.test(userAgent)) return "Internet Explorer";
  return "Other";
}

export function parseSource(referrer: string | null | undefined) {
  if (!referrer) return "Direct";
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();
    const knownSources: Record<string, string> = {
      "instagram.com": "Instagram",
      "l.instagram.com": "Instagram",
      "twitter.com": "Twitter",
      "x.com": "Twitter",
      "t.co": "Twitter",
      "reddit.com": "Reddit",
      "old.reddit.com": "Reddit",
      "out.reddit.com": "Reddit",
      "tiktok.com": "TikTok",
      "youtube.com": "YouTube",
      "m.youtube.com": "YouTube",
      "youtu.be": "YouTube",
      "facebook.com": "Facebook",
      "l.facebook.com": "Facebook",
      "m.facebook.com": "Facebook",
      "linkedin.com": "LinkedIn",
      "lnkd.in": "LinkedIn",
      "google.com": "Google",
      "google.co.in": "Google",
      "google.co.uk": "Google",
      "bing.com": "Bing",
      "duckduckgo.com": "DuckDuckGo",
      "threads.net": "Threads",
      "pinterest.com": "Pinterest",
      "discord.com": "Discord",
      "whatsapp.com": "WhatsApp",
      "snapchat.com": "Snapchat",
      "github.com": "GitHub",
    };
    if (knownSources[host]) return knownSources[host];
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return "Direct";
  }
}

type CloudflareRequest = Request & {
  cf?: { country?: string; city?: string };
};

export function enrichAnalyticsEvent(request: CloudflareRequest, input: AnalyticsEventInput) {
  const userAgent = request.headers.get("user-agent") ?? "";
  const country = request.cf?.country ?? request.headers.get("cf-ipcountry");
  const city = request.cf?.city ?? request.headers.get("cf-ipcity");
  return {
    ...input,
    user_agent: userAgent.slice(0, 512) || null,
    device: parseDevice(userAgent),
    browser: parseBrowser(userAgent),
    country: country && country !== "XX" ? country : null,
    city: city ? decodeURIComponent(city).slice(0, 160) : null,
    source: parseSource(input.referrer),
  } satisfies AnalyticsEvent;
}
