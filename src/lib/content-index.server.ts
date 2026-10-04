/* eslint-disable @typescript-eslint/no-explicit-any -- Indexing jobs and provider rows are server-owned. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { generateConnectedBrainSuggestions, sampleBrainSourcePosts } from "./content-agent.server";
import { indexMediaMetadata, cachePendingContentMedia } from "./content-media.server";
import {
  brainItemFromRow,
  contentProfileFromRow,
  contentProfileSchema,
  contentProfileToRow,
  type ContentProfile,
  type BrainSuggestion,
  type BrainItem,
} from "./content-brain";
import { parsePublicHttpUrl } from "./safe-url";

export async function contentSourceFingerprint(posts: Array<Record<string, unknown>>) {
  const material = posts
    .map((post) => `${post.provider}:${post.remote_post_id}:${post.caption || ""}`)
    .sort()
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sourceBackedBrainItems(
  posts: Array<Record<string, unknown>>,
  generated: BrainSuggestion[],
) {
  const byRef = new Map(posts.map((post) => [`${post.provider}:${post.remote_post_id}`, post]));
  return generated.flatMap((item) => {
    const post = byRef.get(item.sourceRef || "");
    if (
      !post ||
      !item.evidence?.length ||
      item.evidence.some(
        (evidence) =>
          !byRef.has(evidence.sourceRef) ||
          !String(byRef.get(evidence.sourceRef)?.caption || "").includes(evidence.quote),
      )
    )
      return [];
    const sourceUrl = parsePublicHttpUrl(post.remote_post_url, { requireHttps: true })
      ? String(post.remote_post_url)
      : null;
    return [{ ...item, sourceUrl, provenance: "social_post" as const }];
  });
}

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
          .select("*")
          .maybeSingle()
      : await db.from("creator_brain_items").insert(row).select("*").maybeSingle();
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
  load(userId: string): Promise<{
    posts: any[];
    existing: BrainItem[];
    profile?: ContentProfile;
    profileSaved?: boolean;
  }>;
  generate(
    posts: Array<Record<string, unknown>>,
    profile?: ContentProfile,
  ): Promise<BrainSuggestion[]>;
  indexMedia(userId: string, posts: any[]): Promise<unknown>;
  cacheMedia(userId: string): Promise<unknown>;
  save(userId: string, existing: BrainItem[], suggestions: BrainSuggestion[]): Promise<unknown>;
  finish(
    job: any,
    value: { fingerprint?: string; sourceCount: number; error?: string },
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
  async load(userId) {
    await requireContentWorkspace(userId);
    const db = supabaseAdmin as any;
    const [posts, brain, profile, identity] = await Promise.all([
      db
        .from("social_content_insights")
        .select(
          "connection_id,provider,remote_post_id,remote_post_url,caption,content_type,media_sources,published_at,engagements",
        )
        .eq("user_id", userId)
        .order("published_at", { ascending: false })
        .limit(5000),
      db.from("creator_brain_items").select("*").eq("user_id", userId).limit(1000),
      db.from("creator_content_profiles").select("*").eq("user_id", userId).maybeSingle(),
      db.from("profiles").select("account_timezone").eq("id", userId).maybeSingle(),
    ]);
    if (posts.error || brain.error || profile.error || identity.error)
      throw new Error("Your source posts could not be loaded for indexing.");
    return {
      posts: posts.data || [],
      existing: (brain.data || []).map(brainItemFromRow),
      profile: profile.data
        ? contentProfileFromRow(profile.data)
        : contentProfileSchema.parse({ timezone: identity.data?.account_timezone || "UTC" }),
      profileSaved: Boolean(profile.data),
    };
  },
  generate: generateConnectedBrainSuggestions,
  indexMedia: indexMediaMetadata,
  cacheMedia: cachePendingContentMedia,
  save: saveIndexedBrain,
  async finish(job, value) {
    const db = supabaseAdmin as any;
    const [current, pending, ready] = await Promise.all([
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
        .eq("status", "pending"),
      db
        .from("creator_content_media")
        .select("id", { count: "exact", head: true })
        .eq("user_id", job.user_id)
        .eq("status", "ready"),
    ]);
    if (current.error || pending.error || ready.error)
      throw new Error("Source indexing completion could not be checked.");
    if (!current.data) return;
    const changed = current.data.requested_at !== job.requested_at;
    const status = value.error
      ? "error"
      : changed || (pending.count || 0) > 0
        ? "pending"
        : "ready";
    const delay = value.error
      ? Math.min(86_400_000, 60_000 * 2 ** Math.min(job.attempts || 1, 10))
      : 15_000;
    const result = await db
      .from("creator_content_index_jobs")
      .update({
        status,
        next_attempt_at: new Date(Date.now() + delay).toISOString(),
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
      const { posts, existing, profile, profileSaved } = await dependencies.load(job.user_id);
      sourceCount = posts.length;
      await dependencies.indexMedia(job.user_id, posts);
      await dependencies.cacheMedia(job.user_id);
      const fingerprint = await contentSourceFingerprint(posts);
      if (
        posts.some((post) => String(post.caption || "").trim().length >= 8) &&
        fingerprint !== job.source_fingerprint
      ) {
        const generated = await dependencies.generate(sampleBrainSourcePosts(posts), profile);
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
          const { data: media, error } = await db
            .from("creator_content_media")
            .select("id,provider,post_id")
            .eq("user_id", job.user_id);
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
      });
      failed += 1;
    }
  }
  return { claimed: jobs.length, succeeded, failed };
}
