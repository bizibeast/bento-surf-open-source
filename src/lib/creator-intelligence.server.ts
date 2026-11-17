import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { agentBrandingSchema } from "./content-agent-branding";
import { brainDocumentBody, isTrustedBrainItem } from "./content-brain";
import { scrubProviderText } from "./content-connections";
import {
  creatorIntelligencePreferenceFields,
  creatorIntelligencePreferencesSchema,
  type CreatorIntelligencePreferences,
} from "./creator-intelligence";
import { hasPlanEntitlement } from "./plan.server";
import { isPublicSocialProvider, PUBLIC_SOCIAL_PROVIDERS } from "./social-scheduler";

// The profile column, Brain receipts, branding and analytics ship in migrations.
const db = () => supabaseAdmin as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const UNAVAILABLE = "Creator intelligence is unavailable for this workspace.";
const FAILED = "Creator intelligence could not be loaded.";
const SOCIAL_HISTORY_DAYS = 30;
const RECENT_SOCIAL_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export function creatorIntelligenceEnabled() {
  return process.env.BENTO_V2_CREATOR_INTELLIGENCE_ENABLED === "true";
}

async function hasCreatorIntelligence(userId: string) {
  return creatorIntelligenceEnabled() && (await hasPlanEntitlement(userId, "discover"));
}

function safeText(value: string, limit: number) {
  return scrubProviderText(value)
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, "")
    .replace(/\S+@\S+\.\S+/g, "")
    .replace(/\b(?:sk[-_]|gh[pousr]_|github_pat_|sb_secret_|AIza|AKIA)[A-Za-z0-9_-]{12,}\b/g, "")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function safePreferences(data: unknown): CreatorIntelligencePreferences {
  const parsed = creatorIntelligencePreferencesSchema.safeParse(data);
  if (!parsed.success) return {};
  const preferences: CreatorIntelligencePreferences = {};
  for (const { key, maxLength } of creatorIntelligencePreferenceFields) {
    const value = safeText(parsed.data[key] || "", maxLength);
    if (value) preferences[key] = value;
  }
  return preferences;
}

function isSocialRequest(query: string) {
  return /\b(?:analy\w*|perform\w*|social|metrics?|reach|engagement|views|impressions|growth|trend\w*|post\w*|publish\w*|campaign\w*|schedule\w*|twitter|linkedin|instagram|facebook|threads|tiktok|youtube)\b/i.test(
    query,
  );
}

type BrainContextRow = Parameters<typeof isTrustedBrainItem>[0] & {
  kind: string;
  title: string;
  content: string;
  tags: string[] | null;
};

type SocialContextRow = {
  provider: string;
  content_type: string;
  published_at: string;
  fetched_at: string;
  views: number | null;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
};

function optionalMetric(value: number | null) {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function socialPerformance(row: SocialContextRow) {
  if (!isPublicSocialProvider(row.provider)) return [];
  return [
    {
      platform: row.provider,
      format: row.content_type,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      views: optionalMetric(row.views),
      impressions: optionalMetric(row.impressions),
      reach: optionalMetric(row.reach),
      engagements: optionalMetric(row.engagements),
    },
  ];
}

/** userId is the already authorized workspace profile ID. */
export async function getCreatorIntelligence(input: { userId: string; query?: string }) {
  if (!(await hasCreatorIntelligence(input.userId))) return null;
  const workspaceId = input.userId;
  const query = input.query?.slice(0, 1_000).trim();
  const includeSocial = !query || isSocialRequest(query);
  const since = new Date(Date.now() - SOCIAL_HISTORY_DAYS * DAY_MS).toISOString();
  const words = new Set(query?.toLowerCase().match(/[a-z]+/g) ?? []);
  const requestedPlatforms = PUBLIC_SOCIAL_PROVIDERS.filter((platform) => words.has(platform));
  const platforms = requestedPlatforms.length ? requestedPlatforms : PUBLIC_SOCIAL_PROVIDERS;

  const [profile, brain, brand, insights] = await Promise.all([
    db()
      .from("creator_content_profiles")
      .select("goal,niche_keywords,language,region,intelligence_preferences")
      .eq("user_id", workspaceId)
      .maybeSingle(),
    db()
      .from("creator_brain_items")
      .select(
        "kind,title,content,provenance,source_url,source_ref,status,locked,tags,evidence_verification",
      )
      .eq("user_id", workspaceId)
      .eq("status", "confirmed")
      .in("kind", ["profile", "instruction"])
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    db()
      .from("content_agent_preferences")
      .select("branding")
      .eq("user_id", workspaceId)
      .maybeSingle(),
    includeSocial
      ? db()
          .from("social_content_insights")
          .select(
            "provider,content_type,published_at,fetched_at,views,impressions,reach,engagements",
          )
          .eq("user_id", workspaceId)
          .in("provider", platforms)
          .gte("published_at", since)
          .order("published_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(RECENT_SOCIAL_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (profile.error || brain.error || brand.error || insights.error) throw new Error(FAILED);

  const preferences = safePreferences(profile.data?.intelligence_preferences);
  const confirmed = ((brain.data ?? []) as BrainContextRow[]).filter(isTrustedBrainItem);
  const hasConfirmedProfile = confirmed.some((item) => item.kind === "profile");
  const authoredVoice = confirmed.filter(
    (item) =>
      item.provenance === "creator" &&
      item.kind === "instruction" &&
      /^writing voice(?: instructions?)?$/i.test(item.title.trim()),
  );
  const voice =
    authoredVoice.find((item) => item.tags?.includes("canonical-voice")) ?? authoredVoice[0];
  const visualBrand = brand.data?.branding
    ? agentBrandingSchema.safeParse(brand.data.branding)
    : null;
  const savedTopics: string[] = profile.data?.niche_keywords ?? [];

  return {
    preferences,
    profile: profile.data
      ? {
          goal: profile.data.goal === "reach_growth" ? "reach_growth" : "consistent_publishing",
          topics: savedTopics
            .slice(0, 8)
            .map((topic) => safeText(topic, 80))
            .filter(Boolean),
          language: safeText(profile.data.language, 12),
          region: safeText(profile.data.region, 32),
        }
      : null,
    brain: {
      hasConfirmedProfile,
      writingVoice:
        !preferences.voice && voice
          ? safeText(brainDocumentBody(voice.content, voice.title), 600) || null
          : null,
    },
    brand: visualBrand?.success
      ? {
          accentColor: visualBrand.data.accentColor,
          backgroundColor: visualBrand.data.backgroundColor,
          textColor: visualBrand.data.textColor,
          coverStyle: visualBrand.data.coverStyle,
        }
      : null,
    social: includeSocial
      ? {
          since,
          posts: ((insights.data ?? []) as SocialContextRow[]).flatMap(socialPerformance),
        }
      : null,
  };
}

export type CreatorIntelligence = NonNullable<Awaited<ReturnType<typeof getCreatorIntelligence>>>;

export function formatCreatorIntelligenceContext(intelligence: CreatorIntelligence | null) {
  if (!intelligence) return "";
  const { preferences, profile, brain, social } = intelligence;
  const writingVoice = preferences.voice || brain.writingVoice;
  const context = {
    ...(preferences.audience ? { audience: preferences.audience } : {}),
    ...(writingVoice ? { writingVoice } : {}),
    ...(preferences.priorities ? { priorities: preferences.priorities } : {}),
    ...(profile?.topics.length ? { topics: profile.topics } : {}),
    ...(profile && (brain.hasConfirmedProfile || profile.topics.length)
      ? {
          goal: profile.goal,
          ...(profile.language ? { language: profile.language } : {}),
          ...(profile.region ? { region: profile.region } : {}),
        }
      : {}),
    ...(social?.posts.length ? { recentStoredSocialPosts: social.posts.slice(0, 4) } : {}),
  };
  return Object.keys(context).length ? JSON.stringify(context) : "";
}

export async function saveCreatorIntelligencePreferences(
  userId: string,
  input: CreatorIntelligencePreferences,
) {
  if (!(await hasCreatorIntelligence(userId))) throw new Error(UNAVAILABLE);
  const preferences = safePreferences(creatorIntelligencePreferencesSchema.parse(input));
  const table = db().from("creator_content_profiles");
  const { error } = Object.keys(preferences).length
    ? await table.upsert(
        { user_id: userId, intelligence_preferences: preferences },
        { onConflict: "user_id", defaultToNull: false },
      )
    : await table.update({ intelligence_preferences: {} }).eq("user_id", userId);
  if (error) throw new Error("Creator preferences could not be saved.");
  return preferences;
}
