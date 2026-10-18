import { z } from "zod";
import { safeMediaUrl, parsePublicHttpUrl } from "../safe-url";

export type OnboardingProfile = {
  connectionId: string;
  provider: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  biography: string;
  headline: string;
  company: string;
  location: string;
  profileUrl: string | null;
};

export type OnboardingPost = {
  id: string;
  provider: string;
  caption: string;
  url: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  engagements: number | null;
  views: number | null;
};

export type OnboardingEvidence = {
  profiles: OnboardingProfile[];
  postCount: number;
  standout: (OnboardingPost & { comparedPosts: number }) | null;
  inspirations: Array<{ title: string; summary: string; url: string; source: string }>;
};

export const onboardingEvidenceSchema = z.object({
  profiles: z
    .array(
      z.object({
        connectionId: z.string().max(100),
        provider: z.string().max(30),
        name: z.string().max(200),
        handle: z.string().max(100),
        avatarUrl: z.string().nullable(),
        biography: z.string().max(2000),
        headline: z.string().max(500),
        company: z.string().max(300),
        location: z.string().max(300),
        profileUrl: z.string().nullable(),
      }),
    )
    .max(20),
  postCount: z.number().int().min(0).max(120),
  standout: z
    .object({
      id: z.string().max(100),
      provider: z.string().max(30),
      caption: z.string().max(5000),
      url: z.string().nullable(),
      thumbnailUrl: z.string().nullable(),
      publishedAt: z.string().nullable(),
      engagements: z.number().nullable(),
      views: z.number().nullable(),
      comparedPosts: z.number().int(),
    })
    .nullable(),
  inspirations: z
    .array(
      z.object({
        title: z.string().max(300),
        summary: z.string().max(1000),
        url: z.string().url(),
        source: z.string().max(160),
      }),
    )
    .max(3),
});

const text = (value: unknown, limit = 2000) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const publicUrl = (value: unknown) =>
  typeof value === "string" && parsePublicHttpUrl(value, { requireHttps: true }) ? value : null;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Only public profile fields enter preparation. Tokens and arbitrary metadata never do. */
export function onboardingProfile(row: Record<string, unknown>): OnboardingProfile {
  const meta = (row.metadata || {}) as Record<string, unknown>;
  const profile = (meta.profile || meta) as Record<string, unknown>;
  const provider = text(row.provider, 30);
  const handle = text(row.provider_handle, 100).replace(/^@/, "");
  const bases: Record<string, string> = {
    instagram: "https://www.instagram.com/",
    twitter: "https://x.com/",
    threads: "https://www.threads.net/@",
    tiktok: "https://www.tiktok.com/@",
    youtube: "https://www.youtube.com/@",
  };
  return {
    connectionId: text(row.id, 100),
    provider,
    handle,
    name: text(row.provider_display_name, 200) || handle,
    avatarUrl: safeMediaUrl(row.provider_avatar_url) ? String(row.provider_avatar_url) : null,
    biography: text(profile.biography || profile.bio || profile.description),
    headline: text(profile.headline, 500),
    company: text(profile.company || profile.company_name || profile.organization, 300),
    location: text(profile.location, 300),
    profileUrl:
      publicUrl(profile.profile_url || profile.profileUrl || profile.url) ||
      (bases[provider] && handle ? bases[provider] + encodeURIComponent(handle) : null),
  };
}

/** Compare one metric within one platform; never label a limited import an all-time best. */
export function onboardingStandout(rows: Array<Record<string, unknown>>) {
  const posts: OnboardingPost[] = rows
    .filter((row) => text(row.caption))
    .map((row) => ({
      id: text(row.id, 100),
      provider: text(row.provider, 30),
      caption: text(row.caption, 5000),
      url: publicUrl(row.remote_post_url),
      thumbnailUrl: safeMediaUrl(row.thumbnail_url) ? String(row.thumbnail_url) : null,
      publishedAt: text(row.published_at, 100) || null,
      engagements: count(row.engagements),
      views: count(row.views),
    }));
  const measured = posts.filter((post) => post.engagements !== null && post.engagements > 0);
  const selected = measured.sort((a, b) => b.engagements! - a.engagements!)[0];
  if (!selected) return null;
  return {
    ...selected,
    comparedPosts: posts.filter(
      (post) => post.provider === selected.provider && post.engagements !== null,
    ).length,
  };
}
