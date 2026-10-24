/* eslint-disable @typescript-eslint/no-explicit-any -- Private profile cache uses a newly migrated column. */
import { z } from "zod";
import { isTrustedBrainItem } from "./content-brain";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runAiJson, type AiProviderEnv } from "./ai-json.server";
import type { CreatorDiscoverContext } from "./content-discovery.functions";
import type {
  DiscoverInterestResearch,
  SuggestedDiscoverCreator,
} from "./content-discover-personalization";
import { normalizeDiscoverCreator } from "./content-discover-creators";
import {
  fetchDiscoverCreatorProfiles,
  type DiscoverProfileSearchResult,
} from "./content-social-search.server";

const topic = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[\p{L}\p{N}\s&+#,.'’/-]+$/u);
const researchPlanSchema = z
  .object({
    topics: z.array(topic).max(8),
    excludedTopics: z.array(topic).max(8),
    creators: z
      .array(z.object({ name: topic, topics: z.array(topic).min(1).max(4) }).strict())
      .max(6),
  })
  .strict();
type ResearchPlan = z.infer<typeof researchPlanSchema>;
const profileSchema = z.object({
  name: z.string().max(200),
  profileUrl: z.string().max(500),
  platform: z.string().max(30),
  description: z.string().max(600),
});
const cacheSchema = z.object({
  key: z.string(),
  expiresAt: z.number(),
  plan: researchPlanSchema,
  profiles: z.array(profileSchema).max(80),
});
type ResearchCache = z.infer<typeof cacheSchema>;

// Keep confirmed context private and bounded. Only distilled public subject names
// and public creator names go to search; the Brain itself never enters a shared brief.
export function discoverResearchInput(context: CreatorDiscoverContext) {
  const confirmed =
    context.useBrainContext === false ? [] : context.brainItems.filter(isTrustedBrainItem);
  const perItem = Math.min(4_000, Math.floor(24_000 / Math.max(1, confirmed.length)));
  return {
    useBrainContext: context.useBrainContext !== false,
    topics: context.profile.nicheKeywords,
    language: context.profile.language,
    region: context.profile.region,
    brain: confirmed.map((item) => ({
      kind: item.kind,
      title: item.title,
      tags: item.tags || [],
      content: item.content.slice(0, perItem),
    })),
    followed: (context.creators || []).map((creator) => ({
      name: creator.name,
      topics: creator.topics,
    })),
    saved: context.feedbackSeeds
      .slice(0, 12)
      .map((item) => ({ title: item.title, summary: item.summary.slice(0, 250) })),
    ownPosts: [...context.insights]
      .sort((a, b) => (b.engagements || 0) - (a.engagements || 0))
      .slice(0, 8)
      .map((item) => item.caption?.slice(0, 500) || ""),
  };
}
type ResearchInput = ReturnType<typeof discoverResearchInput>;
type Dependencies = {
  generate(
    input: ResearchInput,
    options?: { signal: AbortSignal; timeoutMs: number },
  ): Promise<unknown>;
  searchProfiles(input: {
    name: string;
    language: string;
    region: string;
    signal?: AbortSignal;
  }): Promise<DiscoverProfileSearchResult[]>;
  now?: () => number;
};
const defaults: Dependencies = {
  async generate(input, options) {
    const result = await runAiJson(
      {
        system: `Select content interests and established creators for Bento Discover using this user's confirmed Bento Brain as the primary context. This is not a business-only product. Any industry, craft, profession, hobby, genre, language and region is valid.
Distinguish SUBJECTS from production methods: a comedian improving writing or marketing still wants comedy; a lifestyle creator growing revenue still wants lifestyle. Prioritize stated interests, audiences and content pillars. Honor explicit exclusions and disinterests. Feedback and performance are secondary signals and must not override the Brain. Explicit Discover topics supplement the Brain; without Brain, use those topics and behavior. Do not infer an interest from a negated sentence, an incidental example or an instruction about writing style.
Return {"topics":[up to 8 short public search phrases],"excludedTopics":[explicitly unwanted subject phrases],"creators":[{"name":"public creator name","topics":[matching topics]}]}.
Choose up to 6 genuinely well-known, established creators in the requested subjects. Cover distinct interests and include creators relevant to the user's language and region, alongside globally relevant names. Put one creator per distinct interest first, before second choices for the same interest. Do not default to startup or AI celebrities. Do not include already-followed creators, excluded people, or names you are uncertain exist. These are research candidates, not verified profiles. Never invent handles, URLs, follower counts, scores or performance.
Topics must reflect actual context, not a fixed category list. Include useful synonyms as separate topics when needed for search. Only output broad public interests and public creator names; never output private names, personal anecdotes, contact details, company secrets or verbatim Brain text as search queries. If context gives no useful interests, return empty arrays.`,
        input,
        schema: researchPlanSchema,
        responseFormat: { type: "json_object" },
        temperature: 0.2,
        maxTokens: 1_200,
        timeoutMs: options?.timeoutMs ?? 8_000,
        signal: options?.signal,
      },
      (globalThis.__env__ ?? {}) as AiProviderEnv,
    );
    return result.value;
  },
  searchProfiles: ({ signal, ...input }) => fetchDiscoverCreatorProfiles(input, { signal }),
};

function withinResearchBudget<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function compactName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function verifiedCreators(
  plan: ResearchPlan,
  profiles: DiscoverProfileSearchResult[],
  fromBrain: boolean,
): SuggestedDiscoverCreator[] {
  const seen = new Set<string>();
  return plan.creators.flatMap((candidate): SuggestedDiscoverCreator[] => {
    if (
      !candidate.topics.some((interest) =>
        plan.topics.some((value) => value.toLowerCase() === interest.toLowerCase()),
      )
    )
      return [];
    const profile = profiles.find((item) => {
      if (
        /\b(fans?|fanpage|fanclub|parody|unofficial|tribute|reposts?)\b/i.test(
          `${item.name} ${item.description}`,
        )
      )
        return false;
      if (!compactName(item.name).includes(compactName(candidate.name))) return false;
      try {
        normalizeDiscoverCreator(item.profileUrl);
        return true;
      } catch {
        return false;
      }
    });
    if (!profile) return [];
    const creator = normalizeDiscoverCreator(profile.profileUrl);
    const key = creator.profileUrl.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...creator,
        id: `researched:${key}`,
        name: candidate.name,
        topics: candidate.topics,
        description:
          profile.description ||
          `Explore ${candidate.name}'s public work in ${candidate.topics.join(", ")}.`,
        reason: `Matches your ${fromBrain ? "Brain" : "interests"}: ${candidate.topics.join(", ")}.`,
        score: 75,
        source: fromBrain ? "brain" : "established",
      },
    ];
  });
}

export async function researchDiscoverContext(
  context: CreatorDiscoverContext,
  dependencies: Dependencies = defaults,
  cached?: unknown,
  allowResearch = true,
): Promise<{ research?: DiscoverInterestResearch; cache?: ResearchCache; warnings?: string[] }> {
  const input = discoverResearchInput(context);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  const key = `brain-discover-v1:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const now = dependencies.now?.() ?? Date.now();
  const prior = cacheSchema.safeParse(cached);
  const matchingCache = prior.success && prior.data.key === key ? prior.data : undefined;
  const toResearch = (
    plan: ResearchPlan,
    profiles: DiscoverProfileSearchResult[],
  ): DiscoverInterestResearch => ({
    topics: plan.topics,
    excludedTopics: plan.excludedTopics,
    creators: verifiedCreators(plan, profiles, input.brain.length > 0),
  });
  if (matchingCache && (matchingCache.expiresAt > now || !allowResearch))
    return { research: toResearch(matchingCache.plan, matchingCache.profiles) };
  if (
    !allowResearch ||
    (!input.brain.length &&
      !input.topics.length &&
      !input.saved.length &&
      !input.ownPosts.length &&
      !input.followed.length)
  )
    return {};
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Creator research timed out.", "TimeoutError")),
    12_000,
  );
  try {
    const plan = researchPlanSchema.parse(
      await withinResearchBudget(
        () => dependencies.generate(input, { signal: controller.signal, timeoutMs: 8_000 }),
        controller.signal,
      ),
    );
    // A bounded parallel search validates profiles instead of rendering model-invented links.
    const results = await Promise.allSettled(
      plan.creators.slice(0, 4).map((creator) =>
        withinResearchBudget(
          () =>
            dependencies.searchProfiles({
              name: creator.name,
              language: input.language,
              region: input.region,
              signal: controller.signal,
            }),
          controller.signal,
        ),
      ),
    );
    const profiles = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .concat(matchingCache?.profiles || [])
      .slice(0, 80);
    const incomplete =
      results.some((result) => result.status === "rejected") ||
      (plan.creators.length > 0 &&
        !verifiedCreators(plan, profiles, input.brain.length > 0).length);
    return {
      research: toResearch(plan, profiles),
      cache: {
        key,
        plan,
        profiles,
        expiresAt: now + (incomplete ? 10 * 60_000 : 24 * 60 * 60_000),
      },
      warnings: incomplete
        ? [
            "Some established creator profiles could not be checked. Showing available matches; refresh to retry.",
          ]
        : [],
    };
  } catch {
    return {
      ...(matchingCache
        ? { research: toResearch(matchingCache.plan, matchingCache.profiles) }
        : {}),
      warnings: [
        matchingCache
          ? "Creator research is taking longer than expected. Your previous Brain recommendations are still available."
          : "Deeper Brain recommendations are temporarily unavailable. Showing matches from your topics and saved context.",
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function personalizeDiscoverContext(
  userId: string,
  context: CreatorDiscoverContext,
  refresh: boolean,
): Promise<CreatorDiscoverContext> {
  const db = supabaseAdmin as any;
  const { data } = await db
    .from("creator_content_profiles")
    .select("discover_research")
    .eq("user_id", userId)
    .maybeSingle();
  const result = await researchDiscoverContext(context, defaults, data?.discover_research, refresh);
  if (result.cache) {
    // The cache stays on this user's RLS-protected profile, never a shared topic brief.
    const { error } = await db
      .from("creator_content_profiles")
      .upsert({ user_id: userId, discover_research: result.cache }, { onConflict: "user_id" });
    if (error)
      result.warnings = [
        ...(result.warnings || []),
        "Creator research could not be cached. Your recommendations are still available.",
      ];
  }
  return {
    ...context,
    research: result.research,
    personalizationWarnings: result.warnings || [],
  };
}
