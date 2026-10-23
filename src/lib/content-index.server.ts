import { ProviderBudgetError, withProviderBudgetWorkspace } from "./provider-budget.server";
/* eslint-disable @typescript-eslint/no-explicit-any -- Indexing jobs and provider rows are server-owned. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { generateConnectedBrainSuggestions, sampleBrainSourcePosts } from "./content-agent.server";
import {
  brainItemFromRow,
  sourceBackedBrainItems,
  contentProfileFromRow,
  contentProfileSchema,
  contentProfileToRow,
  type ContentProfile,
  type BrainSuggestion,
  type BrainItem,
} from "./content-brain";
import { BRAIN_ITEM_COLUMNS, CONTENT_PROFILE_COLUMNS } from "./large-table-columns";

export async function contentSourceFingerprint(
  posts: Array<Record<string, unknown>>,
  profile?: ContentProfile,
) {
  const material = posts
    .map((post) => `${post.provider}:${post.remote_post_id}:${post.caption || ""}`)
    .sort()
    .join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      "brain-evidence-v2\n" +
        material +
        (profile ? "\n" + JSON.stringify(contentProfileSchema.parse(profile)) : ""),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { sourceBackedBrainItems } from "./content-brain";

export function existingIndexedBrainItem(existing: BrainItem[], suggestion: BrainSuggestion) {
  return existing.find(
    (item) =>
      item.kind === suggestion.kind &&
      (item.title.toLowerCase() === suggestion.title.toLowerCase() ||
        (item.sourceRef === suggestion.sourceRef && item.kind === "story")),
  );
}

export async function requestContentIndex(userId: string, force = false) {
  const { error } = await (supabaseAdmin as any).rpc("request_creator_content_index", {
    p_user_id: userId,
    p_force: force,
  });
  if (error) throw new Error("Your connected posts could not be queued for indexing.");
  return { queued: true };
}

async function saveIndexedBrain(
  userId: string,
  existing: BrainItem[],
  suggestions: BrainSuggestion[],
) {
  const db = supabaseAdmin as any;
  let saved = 0;
  for (const item of suggestions) {
    const prior = existingIndexedBrainItem(existing, item);
    // Creator confirmations and edits always outrank automatic source refreshes.
    if (prior && (prior.locked || prior.provenance !== "social_post")) continue;
    const row = {
      user_id: userId,
      kind: item.kind,
      title: item.title,
      content: item.content,
      source_url: item.sourceUrl || null,
      source_ref: item.sourceRef || null,
      tags: item.tags || [],
      provenance: "social_post",
      status: "confirmed",
      locked: false,
      updated_at: new Date().toISOString(),
    };
    const result = prior
      ? await db
          .from("creator_brain_items")
          .update(row)
          .eq("id", prior.id)
          .eq("user_id", userId)
          .eq("locked", false)
          .eq("provenance", "social_post")
          .select(BRAIN_ITEM_COLUMNS)
          .maybeSingle()
      : await db.from("creator_brain_items").insert(row).select(BRAIN_ITEM_COLUMNS).maybeSingle();
    if (result.error) throw new Error("Source-backed Brain documents could not be saved.");
    if (result.data) {
      saved += 1;
      const updated = brainItemFromRow(result.data);
      if (prior) existing[existing.indexOf(prior)] = updated;
      else existing.push(updated);
    }
  }
  return saved;
}

export type ContentIndexDependencies = {
  claim(): Promise<any[]>;
  ensureWorkspace(userId: string): Promise<unknown>;
  load(userId: string): Promise<{
    posts: any[];
    sourceCount?: number;
    existing: BrainItem[];
    profile?: ContentProfile;
    profileSaved?: boolean;
  }>;
  generate(
    posts: Array<Record<string, unknown>>,
    profile?: ContentProfile,
    existing?: BrainItem[],
  ): Promise<BrainSuggestion[]>;
  selectMedia(userId: string): Promise<unknown>;
  save(userId: string, existing: BrainItem[], suggestions: BrainSuggestion[]): Promise<unknown>;
  finish(
    job: any,
    value: { fingerprint?: string; sourceCount: number; error?: string; budgetRetryAt?: string },
  ): Promise<void>;
};
const defaults: ContentIndexDependencies = {
  async claim() {
    const { data, error } = await (supabaseAdmin as any).rpc("claim_creator_content_indexes", {
      p_limit: 3,
    });
    if (error) throw new Error("Source indexing jobs could not be claimed.");
    return data || [];
  },
  ensureWorkspace: requireContentWorkspace,
  async load(userId) {
    const db = supabaseAdmin as any;
    const [posts, sourceTotal, brain, profile, identity] = await Promise.all([
      db
        .from("social_content_insights")
        .select("provider,remote_post_id,remote_post_url,caption,published_at,engagements")
        .eq("user_id", userId)
        .order("published_at", { ascending: false })
        .limit(300),
      db
        .from("social_content_insights")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      db.from("creator_brain_items").select(BRAIN_ITEM_COLUMNS).eq("user_id", userId).limit(1000),
      db
        .from("creator_content_profiles")
        .select(CONTENT_PROFILE_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle(),
      db.from("profiles").select("account_timezone").eq("id", userId).maybeSingle(),
    ]);
    if (posts.error || sourceTotal.error || brain.error || profile.error || identity.error)
      throw new Error("Your source posts could not be loaded for indexing.");
    return {
      posts: posts.data || [],
      sourceCount: sourceTotal.count || 0,
      existing: (brain.data || []).map(brainItemFromRow),
      profile: profile.data
        ? contentProfileFromRow(profile.data)
        : contentProfileSchema.parse({ timezone: identity.data?.account_timezone || "UTC" }),
      profileSaved: Boolean(profile.data),
    };
  },
  generate: (posts, profile, existing) =>
    generateConnectedBrainSuggestions(posts, profile, undefined, existing),
  async selectMedia(userId) {
    const { error } = await (supabaseAdmin as any).rpc("refresh_creator_auto_media", {
      p_user_id: userId,
    });
    if (error) throw new Error("Your best-performing media could not be selected.");
  },
  save: saveIndexedBrain,
  async finish(job, value) {
    const db = supabaseAdmin as any;
    const [current, ready] = await Promise.all([
      db
        .from("creator_content_index_jobs")
        .select("requested_at")
        .eq("user_id", job.user_id)
        .eq("lease_id", job.lease_id)
        .maybeSingle(),
      db
        .from("creator_content_media")
        .select("id", { count: "exact", head: true })
        .eq("user_id", job.user_id)
        .eq("status", "ready"),
    ]);
    if (current.error || ready.error)
      throw new Error("Source indexing completion could not be checked.");
    if (!current.data) return;
    const changed = current.data.requested_at !== job.requested_at;
    const status = value.error ? "error" : changed ? "pending" : "ready";
    const delay = value.error
      ? Math.min(86_400_000, 60_000 * 2 ** Math.min(job.attempts || 1, 10))
      : 15_000;
    const result = await db
      .from("creator_content_index_jobs")
      .update({
        status,
        next_attempt_at: value.budgetRetryAt || new Date(Date.now() + delay).toISOString(),
        // Budget pauses are not failed model attempts. Requeue after the actual
        // reset instead of exhausting all three attempts while no call can run.
        ...(value.budgetRetryAt ? { attempts: Math.max(0, (job.attempts || 1) - 1) } : {}),
        lease_id: null,
        lease_expires_at: null,
        source_count: value.sourceCount,
        media_count: ready.count || 0,
        error_message: value.error || null,
        ...(value.fingerprint && !changed
          ? { source_fingerprint: value.fingerprint, indexed_at: new Date().toISOString() }
          : {}),
      })
      .eq("user_id", job.user_id)
      .eq("lease_id", job.lease_id);
    if (result.error) throw new Error("Source indexing completion could not be saved.");
  },
};

export async function processDueContentIndexes(dependencies: ContentIndexDependencies = defaults) {
  const jobs = await dependencies.claim();
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    let sourceCount = 0;
    try {
      await dependencies.ensureWorkspace(job.user_id);
      // Media imports run in their own queue after Brain source indexing completes.
      if (
        job.source_fingerprint &&
        job.indexed_at &&
        job.requested_at &&
        Date.parse(job.indexed_at) >= Date.parse(job.requested_at)
      ) {
        await dependencies.finish(job, { sourceCount: job.source_count || 0 });
        succeeded += 1;
        continue;
      }
      const {
        posts,
        sourceCount: totalPosts,
        existing,
        profile,
        profileSaved,
      } = await dependencies.load(job.user_id);
      sourceCount = totalPosts ?? posts.length;
      await dependencies.selectMedia(job.user_id);
      const fingerprint = await contentSourceFingerprint(posts, profile);
      if (
        posts.some((post) => String(post.caption || "").trim().length >= 8) &&
        fingerprint !== job.source_fingerprint
      ) {
        const generated = await withProviderBudgetWorkspace(job.user_id, () =>
          dependencies.generate(sampleBrainSourcePosts(posts), profile, existing),
        );
        const candidates = sourceBackedBrainItems(posts, generated);
        if (!candidates.length)
          throw new Error(
            "No source-backed persona or stories were returned. Your posts are safe; indexing will retry.",
          );
        await dependencies.save(job.user_id, existing, candidates);
        if (dependencies === defaults && !profileSaved) {
          const nicheKeywords = [...new Set(candidates.flatMap((item) => item.tags || []))].slice(
            0,
            20,
          );
          const { error } = await (supabaseAdmin as any).from("creator_content_profiles").upsert(
            {
              user_id: job.user_id,
              ...contentProfileToRow(contentProfileSchema.parse({ ...profile, nicheKeywords })),
            },
            { onConflict: "user_id", ignoreDuplicates: true },
          );
          if (error) throw new Error("Your source-derived publishing topics could not be saved.");
        }
        const tagsByPost = new Map<string, Set<string>>();
        for (const item of candidates)
          for (const evidence of item.evidence || []) {
            const tags = tagsByPost.get(evidence.sourceRef) || new Set<string>();
            for (const tag of item.tags || []) tags.add(tag);
            tagsByPost.set(evidence.sourceRef, tags);
          }
        // Topic labels travel with the original post's assets, not with copied example photos.
        if (dependencies === defaults && tagsByPost.size) {
          const db = supabaseAdmin as any;
          const postIds = [...tagsByPost.keys()].map((sourceRef) =>
            sourceRef.slice(sourceRef.indexOf(":") + 1),
          );
          const { data: media, error } = await db
            .from("creator_content_media")
            .select("id,provider,post_id")
            .eq("user_id", job.user_id)
            .in("post_id", [...new Set(postIds)])
            // ponytail: one index pass tags at most 500 assets. Raise if a creator's tagged posts exceed that.
            .limit(500);
          if (error) throw new Error("Media topic index could not be loaded.");
          const topics = (media || []).flatMap((asset: any) => {
            const tags = tagsByPost.get(`${asset.provider}:${asset.post_id}`);
            return tags ? [{ id: asset.id, tags: [...tags].slice(0, 8) }] : [];
          });
          for (let offset = 0; offset < topics.length; offset += 100) {
            const result = await db.rpc("apply_creator_media_topics", {
              p_user_id: job.user_id,
              p_topics: topics.slice(offset, offset + 100),
            });
            if (result.error) throw new Error("Media topic labels could not be saved.");
          }
        }
      }
      await dependencies.finish(job, { fingerprint, sourceCount });
      succeeded += 1;
    } catch (cause) {
      await dependencies.finish(job, {
        sourceCount,
        error: cause instanceof Error ? cause.message.slice(0, 1000) : "Source indexing failed.",
        ...(cause instanceof ProviderBudgetError
          ? { budgetRetryAt: cause.retryAt || new Date(Date.now() + 3_600_000).toISOString() }
          : {}),
      });
      failed += 1;
    }
  }
  return { claimed: jobs.length, succeeded, failed };
}
