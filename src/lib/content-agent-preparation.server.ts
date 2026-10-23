/* eslint-disable @typescript-eslint/no-explicit-any -- New preparation RPCs are service-only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { contentAgentCardSchema, type ContentAgentCard } from "./content-agent";
import { storedContentAgentResultSchema } from "./content-agent-proactive";
import { agentBranding } from "./content-agent-branding";
import { carouselCopyIssues, carouselReady, type AgentDraftState } from "./content-carousel";
import { registerAgentMedia, resolveOwnedAgentMedia } from "./content-agent-media.server";
import { getMediaBucket } from "./r2-storage.server";
import { storeGeneratedContentMedia } from "./content-media.server";
import { routinePostId } from "./content-routine-output.server";
import type { SchedulerMedia } from "./social-scheduler";

type Draft = Extract<ContentAgentCard, { type: "draft" }>;
const db = supabaseAdmin as any;
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message || "Draft preparation could not be completed.");
  return data;
}

/** Prefer the creator's chosen portrait, then relevant photos; rotate equally relevant choices. */
export function rankAgentPhotos(rows: any[], card: Draft, heroId: string | null, used: string[]) {
  const generic = new Set([
    "about",
    "better",
    "could",
    "every",
    "from",
    "have",
    "help",
    "into",
    "more",
    "people",
    "photo",
    "post",
    "their",
    "there",
    "these",
    "this",
    "those",
    "with",
    "would",
    "your",
  ]);
  const terms = new Set(
    (
      `${card.title} ${card.visualBrief || ""}`.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []
    ).filter((word) => !generic.has(word)),
  );
  return rows
    .map((row) => {
      const words = new Set(
        `${row.caption || ""} ${(row.tags || []).join(" ")}`
          .toLowerCase()
          .match(/[\p{L}\p{N}]{4,}/gu) || [],
      );
      const relevance = [...terms].filter((word) => words.has(word)).length;
      return {
        row,
        score: row.id === heroId ? 1000 : relevance ? relevance * 10 + (row.singleFace ? 5 : 0) : 0,
        uses: used.filter((id) => id === row.id).length,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.uses - b.uses || a.row.id.localeCompare(b.row.id))
    .map((item) => item.row.id as string);
}

async function choosePhoto(userId: string, card: Draft, heroId: string | null) {
  const [photos, history, quality] = await Promise.all([
    db
      .from("creator_content_media")
      .select("id,caption,tags,storage_key")
      .eq("user_id", userId)
      .eq("status", "ready")
      .eq("media_type", "image")
      .in("mime_type", ["image/jpeg", "image/png"])
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("content_agent_media_plans")
      .select("media_ids")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30),
    db
      .from("content_agent_photo_quality")
      .select("media_id,storage_key")
      .eq("user_id", userId)
      .eq("assessment", "single_face")
      .limit(100),
  ]);
  if (photos.error || history.error || quality.error)
    throw new Error("Your photo library could not be loaded.");
  const candidates = rankAgentPhotos(
    (photos.data || []).map((row: any) => ({
      ...row,
      singleFace: (quality.data || []).some(
        (q: any) => q.media_id === row.id && q.storage_key === row.storage_key,
      ),
    })),
    card,
    heroId,
    (history.data || []).flatMap((p: any) => p.media_ids),
  );
  for (const id of candidates.slice(0, 5)) {
    try {
      await resolveOwnedAgentMedia(userId, [id]);
      return id;
    } catch {
      /* Try the next intact owned photo. */
    }
  }
  return null;
}

async function prepareMedia(
  userId: string,
  card: Draft,
  state: AgentDraftState | undefined,
  input: { messageId: string | null; postId?: string },
) {
  const plan = await rpc("reserve_content_agent_media_plan", {
    p_user_id: userId,
    p_message_id: input.messageId,
    p_card_id: card.cardId,
    p_post_id: input.postId || null,
  });
  const brand = state?.branding || agentBranding(plan.branding);
  const revision = state?.revision || 0;
  let ids = state?.mediaIds?.length ? state.mediaIds : card.mediaIds || [];
  const next: AgentDraftState = {
    ...state,
    revision,
    branding: brand,
    photoRequired: plan.photo_required,
    preparation: "ready",
    preparationNote: "",
  };
  if (card.platform === "instagram") {
    if (card.format !== "carousel") throw new Error("Instagram drafts need a complete carousel.");
    if (carouselReady(card.slides || [], state))
      return { state: next, media: await resolveOwnedAgentMedia(userId, ids), planId: plan.id };
    const issues = carouselCopyIssues(card.slides || []);
    if (issues.length) throw new Error(issues[0]);
    ids = [];
    const { renderAgentCarouselSlide } = await import("./content-carousel-render.server");
    const slides = card.slides!;
    // Existing slide references are explicit creator/model choices; the saved hero is the default.
    const photoIds = slides.map(
      (slide, index) =>
        slide.mediaId ||
        (index === 0 && brand.coverStyle === "portrait" ? brand.heroPhotoId : null),
    );
    if (brand.coverStyle === "portrait" && !photoIds[0])
      throw new Error("Choose a cover photo in Agent settings, or switch to a text-only cover.");
    const portraits = new Map<string, { mime: string; base64: string }>();
    for (const id of new Set(photoIds.filter((id): id is string => Boolean(id)))) {
      const [asset] = await resolveOwnedAgentMedia(userId, [id]);
      if (!/^image\/(jpeg|png|webp)$/.test(asset.mimeType) || asset.size > 8 * 1024 * 1024)
        throw new Error("Choose a JPEG, PNG or WebP portrait under 8 MB.");
      const object = await getMediaBucket().get(asset.key);
      if (!object) throw new Error("Your selected photo is unavailable. Choose another photo.");
      const bytes = new Uint8Array(await object.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      portraits.set(id, { mime: asset.mimeType, base64: btoa(binary) });
    }
    for (let index = 0; index < slides.length; index++) {
      const keyId = await routinePostId(
        plan.id,
        JSON.stringify({
          renderer: 1,
          slides,
          brand,
          photoIds,
          index,
          revision,
          messageId: input.messageId,
        }),
      );
      const key = `users/${userId}/content-agent-images/${keyId}.jpg`;
      if (!(await getMediaBucket().head(key))) {
        const portrait = photoIds[index] ? portraits.get(photoIds[index]!) : undefined;
        const png = await renderAgentCarouselSlide({
          slide: slides[index],
          index,
          count: slides.length,
          brand,
          ...(portrait ? { portrait } : {}),
        });
        await storeGeneratedContentMedia(userId, key, png);
      }
      ids.push(
        await registerAgentMedia(userId, key, "carousel_export", {
          messageId: input.messageId,
          cardId: card.cardId,
          revision,
          slideIndex: index,
        }),
      );
    }
    next.exportRevision = revision;
  } else if (plan.photo_required && ids.length === 0) {
    const id = await choosePhoto(userId, card, brand.heroPhotoId);
    if (id) ids = [id];
    else {
      // An original branded graphic is a usable, inexpensive fallback when the
      // creator has no relevant owned photo. Never lift an unlicensed search image.
      const { renderAgentCarouselSlide } = await import("./content-carousel-render.server");
      const slide = {
        heading: (card.title || card.body.split(/\n|[.!?]\s/)[0]).slice(0, 90),
        body:
          card.body
            .split(/\n\s*\n/)
            .find((part) => part.trim() && part.trim() !== card.title)
            ?.slice(0, 300) || "",
      };
      const keyId = await routinePostId(
        plan.id,
        JSON.stringify({ renderer: 1, slide, brand, revision }),
      );
      const key = `users/${userId}/content-agent-images/${keyId}.jpg`;
      if (!(await getMediaBucket().head(key))) {
        const png = await renderAgentCarouselSlide({ slide, index: 0, count: 1, brand });
        await storeGeneratedContentMedia(userId, key, png);
      }
      ids = [
        await registerAgentMedia(userId, key, "carousel_export", {
          messageId: input.messageId,
          cardId: card.cardId,
          revision,
          slideIndex: 0,
        }),
      ];
      next.preparationNote =
        "A visual in your brand colours is attached. You can replace it with a photo.";
    }
  }
  const media = await resolveOwnedAgentMedia(userId, ids);
  next.mediaIds = ids;
  if (plan.photo_required && !media.some((asset) => /^image\//.test(asset.mimeType))) {
    next.preparation = "photo_needed";
    next.preparationNote = "This post needs a photo before publishing.";
  }
  return { state: next, media, planId: plan.id };
}

/** Called after a durable message commit and on explicit repair, never on a model-provided owner. */
export async function prepareAgentMessage(userId: string, messageId: string, onlyCardId?: string) {
  const { data: message, error } = await db
    .from("content_agent_messages")
    .select("payload")
    .eq("user_id", userId)
    .eq("id", messageId)
    .eq("role", "assistant")
    .gt("expires_at", new Date().toISOString())
    .single();
  if (error || !message) throw new Error("This draft is unavailable.");
  const result = storedContentAgentResultSchema.parse(message.payload);
  const rejected = new Set(result.rejectedDraftIds || []);
  if (onlyCardId && rejected.has(onlyCardId)) throw new Error("This draft was rejected.");
  for (const card of result.cards) {
    if (
      card.type !== "draft" ||
      rejected.has(card.cardId) ||
      (onlyCardId && card.cardId !== onlyCardId) ||
      !["twitter", "linkedin", "instagram"].includes(card.platform)
    )
      continue;
    let state = result.draftStates?.[card.cardId];
    if (
      state?.preparation === "ready" &&
      (card.platform !== "instagram" || carouselReady(card.slides || [], state))
    )
      continue;
    if (onlyCardId && state?.preparation && state.preparation !== "ready") {
      // Explicit repair can use updated preferences; already reviewed visuals keep their snapshot.
      const { data: prefs, error: prefsError } = await db
        .from("content_agent_preferences")
        .select("branding")
        .eq("user_id", userId)
        .single();
      if (prefsError) throw new Error("Your carousel style could not be loaded.");
      state = { ...state, branding: agentBranding(prefs?.branding) };
    }
    let prepared: Awaited<ReturnType<typeof prepareMedia>>;
    try {
      prepared = await prepareMedia(userId, card, state, { messageId });
    } catch (cause) {
      // Persist a visible, actionable state. Copy remains durable if storage is unavailable.
      const note =
        cause instanceof Error
          ? cause.message.slice(0, 500)
          : "Visuals could not be prepared. Try again.";
      prepared = {
        state: {
          ...state,
          revision: state?.revision || 0,
          branding: state?.branding || agentBranding(null),
          photoRequired: card.platform === "linkedin" || state?.photoRequired,
          mediaIds: [],
          preparation: "visuals_needed",
          preparationNote: note,
        },
        media: [],
        planId: null,
      };
    }
    // The RPC rechecks the exact message revision and canonical scheduler edit timestamp.
    await rpc("mutate_content_agent_draft", {
      p_user_id: userId,
      p_message_id: messageId,
      p_card_id: card.cardId,
      p_revision: state?.revision || 0,
      p_operation: "prepare",
      p_patch: prepared.state,
      p_media: prepared.media,
    });
    if (prepared.planId)
      await db
        .from("content_agent_media_plans")
        .update({ media_ids: prepared.state.mediaIds || [] })
        .eq("user_id", userId)
        .eq("id", prepared.planId);
  }
  const { data: latest, error: readError } = await db
    .from("content_agent_messages")
    .select("payload")
    .eq("user_id", userId)
    .eq("id", messageId)
    .single();
  if (readError || !latest) throw new Error("Reload the conversation to see your prepared draft.");
  return storedContentAgentResultSchema.parse(latest.payload);
}

/** Insert-only routine preparation and legacy draft repair preserve scheduler edits via CAS. */
export async function prepareAgentPost(userId: string, postId: string) {
  await rpc("prepare_content_agent_destinations", { p_user_id: userId, p_post_id: postId });
  const { data: post, error } = await db
    .from("social_posts")
    .select("id,body,title,status,media,settings,updated_at")
    .eq("user_id", userId)
    .eq("id", postId)
    .single();
  if (error || !post || post.status !== "draft") return;
  const parsed = contentAgentCardSchema.safeParse(post.settings?.card);
  if (!parsed.success || parsed.data.type !== "draft") return;
  const card = parsed.data;
  if (post.body !== card.body || (post.title || "") !== card.title) return;
  const state = post.settings?.agentDraftState as AgentDraftState | undefined;
  if (state?.preparation === "ready" || post.media?.length) return;
  let prepared: { state: AgentDraftState; media: SchedulerMedia[]; planId: string | null };
  try {
    prepared = await prepareMedia(userId, card, state, { messageId: null, postId });
  } catch (cause) {
    prepared = {
      state: {
        revision: state?.revision || 0,
        preparation: "visuals_needed",
        preparationNote:
          cause instanceof Error ? cause.message.slice(0, 500) : "Visuals could not be prepared.",
        photoRequired: card.platform === "linkedin",
      },
      media: [],
      planId: null,
    };
  }
  const saved = await rpc("prepare_content_agent_post", {
    p_user_id: userId,
    p_post_id: postId,
    p_updated_at: post.updated_at,
    p_state: prepared.state,
    p_media: prepared.media,
  });
  if (saved && prepared.planId)
    await db
      .from("content_agent_media_plans")
      .update({ media_ids: prepared.state.mediaIds || [] })
      .eq("user_id", userId)
      .eq("id", prepared.planId);
}
