import { reserveProviderUsage } from "./provider-budget.server";
/* eslint-disable @typescript-eslint/no-explicit-any -- Generated Supabase types are updated after the migration is applied. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeDiscoverCreator } from "./content-discover-creators";
import { publicSourceUrl } from "./content-source-media";
import { readResponseText } from "./request-security.server";
import type { SocialMentionSuggestion } from "./social-mentions";

type MentionProvider = SocialMentionSuggestion["provider"];

const profileGroups: Partial<Record<MentionProvider, string>> = {
  twitter: "site:x.com/ OR site:twitter.com/",
  facebook: "site:facebook.com/",
  instagram: "site:instagram.com/",
  linkedin: "site:linkedin.com/in/ OR site:linkedin.com/company/",
  threads: "site:threads.com/@ OR site:threads.net/@",
  tiktok: "site:tiktok.com/@",
  youtube: "site:youtube.com/@",
};

const platformNames: Record<string, MentionProvider> = {
  X: "twitter",
  Facebook: "facebook",
  Instagram: "instagram",
  LinkedIn: "linkedin",
  Threads: "threads",
  TikTok: "tiktok",
  YouTube: "youtube",
};

function profileName(title: string, handle: string) {
  const name = title
    .replace(/\s*\(@[^)]*\)/g, "")
    .replace(/\s*[|/–-]\s*(?:X|Twitter|Facebook|Instagram|LinkedIn|Threads|TikTok|YouTube).*$/i, "")
    .trim();
  return (name || handle).slice(0, 100);
}

/** A search result is a public profile lead, never a native platform mention ID. */
export function parseBrightDataMentionProfiles(
  payload: unknown,
  provider: MentionProvider,
  query: string,
): SocialMentionSuggestion[] {
  if (!payload || typeof payload !== "object") return [];
  const organic = (payload as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return [];
  const seen = new Set<string>();
  const needle = query.toLocaleLowerCase().replace(/^@/, "").trim();
  const words = needle.split(/\s+/).filter(Boolean);
  const items: SocialMentionSuggestion[] = [];
  for (const row of organic.slice(0, 30)) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.link !== "string" || typeof candidate.title !== "string") continue;
    try {
      const profile = normalizeDiscoverCreator(candidate.link);
      if (platformNames[profile.platform] !== provider) continue;
      const url = new URL(profile.profileUrl);
      const path = url.pathname.split("/").filter(Boolean);
      if (provider === "youtube" && path[0] === "channel") continue;
      const rawHandle = path.at(-1)?.replace(/^@/, "") || "";
      const handle = rawHandle;
      if (provider === "twitter" && !/^[A-Za-z0-9_]{1,15}$/.test(rawHandle)) continue;
      if (provider === "facebook" && ["groups", "profile.php"].includes(path[0])) continue;
      const name = profileName(candidate.title, rawHandle);
      const haystack = `${name} ${handle || ""}`.toLocaleLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      const key = (handle || profile.profileUrl).toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        provider,
        id: profile.profileUrl,
        name,
        handle,
        kind: provider === "youtube" ? "channel" : "person",
        verified: false,
        avatarUrl: publicSourceUrl(candidate.thumbnail) || publicSourceUrl(candidate.image),
        detail:
          provider === "twitter"
            ? "Public X profile. X links existing @handles in published posts."
            : "Public profile. A clickable tag depends on the platform's publishing API.",
      });
      if (items.length === 3) break;
    } catch {
      // Ignore SERP rows that are posts, redirects, or unrelated domains.
    }
  }
  return items;
}

export async function searchBrightDataMentionProfiles(provider: MentionProvider, query: string) {
  const group = profileGroups[provider];
  const key = process.env.BRIGHT_DATA_API_KEY?.trim();
  const clean = query.replace(/^@/, "").trim().toLocaleLowerCase();
  if (!group || clean.length < 3 || clean.length > 60)
    return { items: [] as SocialMentionSuggestion[], detail: "Type at least 3 letters to search." };
  if (!key)
    return { items: [] as SocialMentionSuggestion[], detail: "Account search is not configured." };

  const { data: cached } = await (supabaseAdmin as any)
    .from("social_mention_search_cache")
    .select("items")
    .eq("provider", provider)
    .eq("query", clean)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (cached && Array.isArray(cached.items)) {
    return { items: cached.items as SocialMentionSuggestion[], detail: null };
  }

  const currentMonth = new Date().toISOString().slice(0, 7) + "-01";
  const requestedLimit = Number(process.env.SOCIAL_MENTION_BRIGHT_DATA_MONTHLY_LIMIT);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 3000
      ? requestedLimit
      : process.env.APP_ENV === "production"
        ? 600
        : 100;
  const { data: reserved, error: reservationError } = await (supabaseAdmin as any).rpc(
    "claim_social_mention_search_budget",
    { p_period_start: currentMonth, p_limit: limit },
  );
  if (reservationError || reserved !== true) {
    return {
      items: [] as SocialMentionSuggestion[],
      detail: "Public account search has reached its monthly limit. Try a known @handle.",
    };
  }

  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", `(${group}) (${clean.replace(/[()"\\]/g, " ")})`);
  target.searchParams.set("num", "20");
  target.searchParams.set("hl", "en");
  try {
    await reserveProviderUsage("bright_data_requests");
    const response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        zone: process.env.BRIGHT_DATA_SERP_ZONE || "serp_api1",
        url: target.toString(),
        format: "json",
        data_format: "parsed",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        items: [] as SocialMentionSuggestion[],
        detail: `Public account search is unavailable (HTTP ${response.status}).`,
      };
    }
    let payload = JSON.parse(await readResponseText(response, 2 * 1024 * 1024));
    if (payload?.status_code !== undefined) {
      if (Number(payload.status_code) !== 200)
        return {
          items: [] as SocialMentionSuggestion[],
          detail: Number.isInteger(Number(payload.status_code))
            ? `Public account search is unavailable (upstream HTTP ${Number(payload.status_code)}).`
            : "Public account search returned an invalid status.",
        };
      if (payload.body)
        payload = typeof payload.body === "string" ? JSON.parse(payload.body) : payload.body;
    }
    if (!Array.isArray(payload?.organic))
      return {
        items: [] as SocialMentionSuggestion[],
        detail: "Public account search returned no results.",
      };
    const items = parseBrightDataMentionProfiles(payload, provider, clean);
    await (supabaseAdmin as any).from("social_mention_search_cache").upsert({
      provider,
      query: clean,
      items,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    });
    return { items, detail: null };
  } catch {
    return {
      items: [] as SocialMentionSuggestion[],
      detail: "Public account search is temporarily unavailable.",
    };
  }
}
