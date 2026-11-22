import { freeToolsBySlug, freeToolPlatforms, type FreeToolPlatform } from "./free-tools";
import { splitThreadText, stylizeUnicodeText, type UnicodeTextStyle } from "./free-text-tools";

export const deterministicFreeToolSlugs = [
  "utm-link-builder",
  "social-media-character-counter",
  "youtube-title-counter",
  "instagram-bio-counter",
  "linkedin-headline-counter",
  "social-post-formatter",
  "instagram-line-break-generator",
  "social-bold-italic-text",
  "twitter-thread-splitter",
] as const;

export type DeterministicFreeToolSlug = (typeof deterministicFreeToolSlugs)[number];

export type DeterministicFreeToolInput = {
  toolSlug: DeterministicFreeToolSlug;
  text?: string;
  platform?: FreeToolPlatform;
  style?: UnicodeTextStyle;
  numbered?: boolean;
  url?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
};

const platformLimits: Record<FreeToolPlatform, number> = {
  Instagram: 2_200,
  LinkedIn: 3_000,
  X: 280,
  Facebook: 63_206,
  Threads: 500,
  TikTok: 4_000,
  YouTube: 5_000,
  Reddit: 40_000,
};

function cleanText(input: string, lineBreaker: boolean) {
  const clean = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return lineBreaker ? clean.replace(/\n\n/g, "\n⠀\n") : clean;
}

export function runDeterministicFreeTool(input: DeterministicFreeToolInput) {
  const { toolSlug } = input;
  const tool = freeToolsBySlug.get(toolSlug);
  if (!tool || !deterministicFreeToolSlugs.includes(toolSlug))
    throw new Error("Choose a supported text or link tool.");

  if (toolSlug === "utm-link-builder") {
    const source = input.source?.trim();
    const campaign = input.campaign?.trim();
    if (!source || !campaign) throw new Error("Add a campaign source and campaign name.");
    const raw = input.url?.trim();
    if (!raw) throw new Error("Add a destination URL.");
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error("Enter a valid destination URL.");
    }
    for (const key of ["source", "medium", "campaign", "term", "content"] as const) {
      const value = (input[key] ?? (key === "medium" ? "social" : "")).trim();
      if (value) url.searchParams.set(`utm_${key}`, value.toLowerCase().replace(/\s+/g, "-"));
    }
    return { toolSlug, url: url.toString() };
  }

  const text = input.text ?? "";
  if (tool.kind === "counter") {
    const platform = input.platform ?? "Instagram";
    if (!freeToolPlatforms.includes(platform)) throw new Error("Choose a supported platform.");
    const limit = tool.counterLimit ?? platformLimits[platform];
    const characters = Array.from(text).length;
    return {
      toolSlug,
      characters,
      remaining: limit - characters,
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      lines: text ? text.split(/\r?\n/).length : 0,
      limit,
      platform: tool.counterLimit === undefined ? platform : null,
    };
  }
  if (toolSlug === "social-post-formatter" || toolSlug === "instagram-line-break-generator") {
    return { toolSlug, text: cleanText(text, toolSlug === "instagram-line-break-generator") };
  }
  if (toolSlug === "social-bold-italic-text") {
    const style = input.style ?? "bold";
    if (!["bold", "italic", "bold-italic", "normal"].includes(style))
      throw new Error("Choose a supported text style.");
    return { toolSlug, text: stylizeUnicodeText(text, style) };
  }
  const posts = splitThreadText(text, input.numbered !== false);
  if (posts.length > 99 || posts.some((post) => Array.from(post).length > 280))
    throw new Error("The thread is too long. Use 99 posts or fewer.");
  return { toolSlug, posts };
}
