/* eslint-disable @typescript-eslint/no-explicit-any -- Content tables ship with their migrations. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import {
  brainItemInputSchema,
  type BrainItem,
  contentProfileFromRow,
  contentProfileSchema,
  contentProfileToRow,
} from "./content-brain";
import {
  loadContentBrain,
  loadContentBrainMedia,
  searchContentBrainMediaForUser,
} from "./content-brain.functions";
import { BRAIN_MEDIA_BUDGET_BYTES, MANUAL_MEDIA_LIMIT, MEDIA_FOLDER_LIMIT } from "./content-media";
import {
  enqueueDueContentMediaImports,
  type ContentMediaImportMessage,
} from "./content-media.server";
import { getMediaBucket, mediaObjectUrl } from "./r2-storage.server";
import { parsePublicHttpUrl } from "./safe-url";
import { getPlan } from "./plan.server";
import { CONTENT_PROFILE_COLUMNS } from "./large-table-columns";
import { uploadLimitMb } from "./plans";
import { nextContentRoutineRun } from "./content-routines";
import { routineInputSchema } from "./content-routines.functions";
import { requestContentIndex } from "./content-index.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { runContentAgentTurn } from "./content-agent.server";
import {
  agentCardActionSchema,
  agentScheduleApprovalSchema,
  approveAgentBrainProposalForUser,
  approveAgentScheduleProposalForUser,
  loadAssistantResult,
} from "./content-agent.actions";
import { listContentAgentThreadsForWorkspace } from "./content-agent-identity.server";
import {
  loadMoreDiscoverForUser,
  loadMoreDiscoverInputSchema,
  readStoredDiscover,
  refreshContentDiscoverForUser,
} from "./content-discovery.functions";
import { trackDiscoverCreatorSchema } from "./content-discover-creators";
import { readDiscoverFollows } from "./content-discover-follows.server";

const db = () => supabaseAdmin as any;
const uuid = z.string().uuid();

export const brainMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_profile"), profile: contentProfileSchema }),
  z.object({ action: z.literal("save_item"), item: brainItemInputSchema }),
  z.object({ action: z.literal("confirm_item"), id: uuid }),
  z.object({ action: z.literal("lock_item"), id: uuid, locked: z.boolean() }),
  z.object({ action: z.literal("delete_item"), id: uuid }),
  z.object({ action: z.literal("refresh_index") }),
]);

export const mediaMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("register_upload"),
    key: z.string().max(500),
    name: z.string().trim().min(1).max(160),
  }),
  z.object({ action: z.literal("request_post"), url: z.string().trim().max(2000) }),
  z.object({ action: z.literal("create_folder"), name: z.string().trim().min(1).max(80) }),
  z.object({
    action: z.literal("rename_folder"),
    id: uuid,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ action: z.literal("delete_folder"), id: uuid }),
  z.object({ action: z.literal("move_item"), id: uuid, folderId: uuid.nullable() }),
  z.object({
    action: z.literal("set_hero"),
    slot: z.number().int().min(1).max(4),
    id: uuid.nullable(),
  }),
]);

export const routineMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), routine: routineInputSchema }),
  z.object({ action: z.literal("pause"), id: uuid, paused: z.boolean() }),
]);

export const agentMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send_message"),
    threadId: uuid.nullable().optional(),
    text: z.string().trim().min(1).max(20_000),
  }),
  agentCardActionSchema.extend({ action: z.literal("approve_brain") }),
  agentScheduleApprovalSchema.extend({ action: z.literal("approve_schedule") }),
  agentCardActionSchema.extend({
    action: z.literal("reject_draft"),
    reason: z.string().trim().min(1).max(1_000),
  }),
  agentCardActionSchema.extend({
    action: z.literal("regenerate_draft"),
    reason: z.string().trim().min(1).max(1_000),
  }),
  agentCardActionSchema.extend({
    action: z.literal("save_draft"),
    body: z.string().trim().min(1).max(10_000),
  }),
]);

export const discoverMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh"), force: z.boolean().default(false) }),
  loadMoreDiscoverInputSchema.extend({ action: z.literal("load_more") }),
  z.object({
    action: z.literal("feedback"),
    id: uuid,
    feedback: z.enum(["pending", "liked", "saved", "not_relevant"]),
  }),
  z.object({ action: z.literal("save_item"), id: uuid }),
  z.object({ action: z.literal("unsave_item"), id: uuid }),
  z.object({
    action: z.literal("save_preferences"),
    nicheKeywords: z.array(z.string().trim().min(1).max(80)).max(20),
    useBrainContext: z.boolean().default(true),
    language: z.string().trim().min(2).max(12),
    region: z.string().trim().min(2).max(80),
  }),
  trackDiscoverCreatorSchema.extend({ action: z.literal("track_creator") }),
  z.object({ action: z.literal("untrack_creator"), id: uuid }),
]);

async function ownedMutation(query: any, message: string) {
  const { data, error } = await query.select("id").maybeSingle();
  if (error || !data) throw new Error(message);
  return { id: String(data.id) };
}

export async function getMcpContentBrain(userId: string) {
  await requireContentWorkspace(userId);
  const brain = await loadContentBrain(userId, 21);
  return {
    ...brain,
    items: brain.items.slice(0, 20).map((item: BrainItem) => ({
      ...item,
      content: item.content.slice(0, 2000),
      contentTruncated: item.content.length > 2000,
    })),
    dataAccess: {
      tool: "read_workspace_data",
      collections: ["brain_items", "brain_sources"],
      hasMoreItems: brain.items.length > 20,
      fullText: "Pass a document id to read its full text.",
    },
  };
}

export async function manageMcpContentBrain(userId: string, input: unknown) {
  const data = brainMutationSchema.parse(input);
  await requireContentWorkspace(userId);
  if (data.action === "save_profile") {
    const { error } = await db()
      .from("creator_content_profiles")
      .upsert({
        user_id: userId,
        ...contentProfileToRow(data.profile),
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error("The Content profile could not be saved.");
    await requestContentIndex(userId, true);
    return { saved: true };
  }
  if (data.action === "refresh_index") {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "content-brain-inference", userId);
    return requestContentIndex(userId, true);
  }
  if (data.action === "save_item") {
    const item = data.item;
    const row = {
      user_id: userId,
      kind: item.kind,
      title: item.title,
      content: item.content,
      provenance: item.provenance,
      source_url: item.sourceUrl || null,
      source_ref: item.sourceRef || null,
      status: item.status,
      locked: item.locked,
      ...(item.tags ? { tags: item.tags } : {}),
      updated_at: new Date().toISOString(),
    };
    let itemId = item.id;
    if (
      !itemId &&
      ["My Human", "Bento Memories", "Writing voice", "X Strategy", "LinkedIn Strategy"].includes(
        item.title,
      )
    ) {
      const { data: prior, error } = await db()
        .from("creator_brain_items")
        .select("id")
        .eq("user_id", userId)
        .eq("kind", item.kind)
        .eq("title", item.title)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("The Brain document could not be loaded for saving.");
      itemId = prior?.id;
    }
    return ownedMutation(
      itemId
        ? db().from("creator_brain_items").update(row).eq("id", itemId).eq("user_id", userId)
        : db().from("creator_brain_items").insert(row),
      "The Brain item could not be saved.",
    );
  }
  if (data.action === "confirm_item")
    return ownedMutation(
      db()
        .from("creator_brain_items")
        .update({ status: "confirmed", locked: true, updated_at: new Date().toISOString() })
        .eq("id", data.id)
        .eq("user_id", userId),
      "The Brain item could not be confirmed.",
    );
  if (data.action === "lock_item")
    return ownedMutation(
      db()
        .from("creator_brain_items")
        .update({ locked: data.locked, updated_at: new Date().toISOString() })
        .eq("id", data.id)
        .eq("user_id", userId),
      "The Brain item lock could not be changed.",
    );
  return ownedMutation(
    db().from("creator_brain_items").delete().eq("id", data.id).eq("user_id", userId),
    "The Brain item could not be deleted.",
  );
}

export async function getMcpContentMedia(
  userId: string,
  input: { page?: number; query?: string; previewOld?: boolean } = {},
) {
  if (input.previewOld) {
    await requireContentWorkspace(userId);
    const { data, error } = await db().rpc("creator_legacy_media_cleanup_preview", {
      p_user_id: userId,
    });
    if (error) throw new Error("Old Media could not be reviewed.");
    return {
      cleanupPreview: {
        itemCount: Number(data?.[0]?.item_count || 0),
        possibleBytes: Number(data?.[0]?.possible_bytes || 0),
        items: (data?.[0]?.items || []).map((item: any) => ({
          id: String(item.id),
          title: String(item.title || item.provider || "Media"),
          provider: String(item.provider),
          byteSize: Number(item.byte_size || 0),
        })),
      },
    };
  }
  const page = z
    .number()
    .int()
    .min(0)
    .max(100)
    .parse(input.page ?? 0);
  const search = z
    .string()
    .trim()
    .max(300)
    .parse(input.query ?? "");
  const limits = {
    manualItems: MANUAL_MEDIA_LIMIT,
    bytes: BRAIN_MEDIA_BUDGET_BYTES,
    folders: MEDIA_FOLDER_LIMIT,
    heroImages: 4,
  };
  if (search) {
    return {
      photos: await searchContentBrainMediaForUser(userId, search),
      hasMore: false,
      limits,
    };
  }
  const library = await loadContentBrainMedia(userId, page);
  return { ...library, limits };
}

async function manualMediaAvailability(userId: string) {
  const [count, usage] = await Promise.all([
    db()
      .from("creator_content_media")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("import_origin", ["requested", "upload"]),
    db().rpc("creator_brain_media_used_bytes", { p_user_id: userId }),
  ]);
  if (count.error || usage.error) throw new Error("Media library limits could not be checked.");
  return { count: Number(count.count || 0), bytes: Number(usage.data || 0) };
}

export async function manageMcpContentMedia(userId: string, input: unknown) {
  const data = mediaMutationSchema.parse(input);
  await requireContentWorkspace(userId);
  if (data.action === "register_upload") {
    if (
      !data.key.startsWith(`users/${userId}/image/`) &&
      !data.key.startsWith(`users/${userId}/video/`)
    )
      throw new Error("This upload is not in your Media library.");
    const object = await getMediaBucket().head(data.key);
    const mime = object?.httpMetadata?.contentType || "";
    if (!object || !/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/.test(mime))
      throw new Error("This Media upload is unavailable or unsupported.");
    const plan = await getPlan(userId);
    if (
      object.size >
      uploadLimitMb(mime.startsWith("video/") ? "video" : "image", plan) * 1024 * 1024
    )
      throw new Error("This file exceeds your plan's upload size limit.");
    const usage = await manualMediaAvailability(userId);
    if (usage.count >= MANUAL_MEDIA_LIMIT)
      throw new Error("Your Media library has 50 manual items.");
    if (usage.bytes + object.size > BRAIN_MEDIA_BUDGET_BYTES)
      throw new Error("Your Brain Media library has reached its 1 GB limit.");
    const { data: id, error } = await db().rpc("register_creator_uploaded_media", {
      p_user_id: userId,
      p_key: data.key,
      p_url: mediaObjectUrl(data.key),
      p_name: data.name,
      p_mime: mime,
      p_bytes: object.size,
    });
    if (error || !id) throw new Error(error?.message || "This upload could not be added to Media.");
    return { id: String(id) };
  }
  if (data.action === "request_post") {
    const url = parsePublicHttpUrl(data.url, { requireHttps: true });
    if (!url) throw new Error("Enter a valid HTTPS link to your connected post.");
    const canonical = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const { data: post, error } = await db()
      .from("social_content_insights")
      .select("id")
      .eq("user_id", userId)
      .in("remote_post_url", [...new Set([data.url, canonical, `${canonical}/`])])
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("This connected post could not be found.");
    if (!post)
      throw new Error("Refresh Social Insights for this post, or upload its file instead.");
    const result = await db().rpc("request_creator_media_from_post", {
      p_user_id: userId,
      p_post_id: post.id,
    });
    if (result.error || !result.data)
      throw new Error(result.error?.message || "This post could not be queued.");
    const queue = (
      globalThis.__env__ as { CONTENT_MEDIA_QUEUE?: Queue<ContentMediaImportMessage> } | undefined
    )?.CONTENT_MEDIA_QUEUE;
    if (queue) await enqueueDueContentMediaImports(queue, 1).catch(() => undefined);
    return { id: String(result.data), queued: true };
  }
  if (data.action === "create_folder") {
    const { count, error } = await db()
      .from("creator_media_folders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) throw new Error("Media folders could not be counted.");
    if ((count || 0) >= MEDIA_FOLDER_LIMIT)
      throw new Error("You can create up to 20 Media folders.");
    const result = await db()
      .from("creator_media_folders")
      .insert({ user_id: userId, name: data.name })
      .select("id,name")
      .single();
    if (result.error || !result.data) throw new Error("This Media folder could not be created.");
    return result.data;
  }
  if (data.action === "rename_folder")
    return ownedMutation(
      db()
        .from("creator_media_folders")
        .update({ name: data.name })
        .eq("id", data.id)
        .eq("user_id", userId),
      "This Media folder could not be renamed.",
    );
  if (data.action === "delete_folder")
    return ownedMutation(
      db().from("creator_media_folders").delete().eq("id", data.id).eq("user_id", userId),
      "This Media folder could not be deleted.",
    );
  if (data.action === "move_item") {
    if (data.folderId) {
      const { data: folder, error } = await db()
        .from("creator_media_folders")
        .select("id")
        .eq("id", data.folderId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error || !folder) throw new Error("This Media folder is unavailable.");
    }
    return ownedMutation(
      db()
        .from("creator_content_media")
        .update({ folder_id: data.folderId })
        .eq("id", data.id)
        .eq("user_id", userId)
        .eq("status", "ready"),
      "This Media item could not be moved.",
    );
  }
  const { error } = await db().rpc("set_creator_hero_media", {
    p_user_id: userId,
    p_media_id: data.id,
    p_slot: data.slot,
  });
  if (error) throw new Error("This hero image could not be saved.");
  return { saved: true };
}

export async function getMcpContentRoutines(userId: string) {
  await requireContentWorkspace(userId);
  const [routines, activity] = await Promise.all([
    db()
      .from("content_routines")
      .select("id,template,enabled,schedule,timezone,platforms,next_run_at,last_run_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    db()
      .from("content_routine_runs")
      .select("id,routine_id,status,result_count,error_message,scheduled_for")
      .eq("user_id", userId)
      .order("scheduled_for", { ascending: false })
      .limit(30),
  ]);
  if (routines.error || activity.error) throw new Error("Content routines could not be loaded.");
  return {
    routines: routines.data || [],
    activity: activity.data || [],
    dataAccess: {
      tool: "read_workspace_data",
      collections: ["routines", "routine_runs"],
      recentActivityLimit: 30,
    },
  };
}

export async function manageMcpContentRoutine(userId: string, input: unknown) {
  const data = routineMutationSchema.parse(input);
  await requireContentWorkspace(userId);
  if (data.action === "save") {
    const routine = data.routine;
    const schedule = {
      outputMode: routine.outputMode || "draft",
      intervalMinutes: routine.intervalMinutes,
      time: routine.time,
      ...(routine.name ? { name: routine.name } : {}),
      ...(routine.instructions ? { instructions: routine.instructions } : {}),
      ...(routine.catalogKey ? { catalogKey: routine.catalogKey } : {}),
    };
    const nextRunAt = routine.enabled
      ? nextContentRoutineRun(schedule, routine.timezone).toISOString()
      : null;
    const { data: saved, error } = await db()
      .from("content_routines")
      .upsert(
        {
          user_id: userId,
          template: routine.template,
          enabled: routine.enabled,
          schedule,
          timezone: routine.timezone,
          platforms: routine.platforms,
          next_run_at: nextRunAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,template" },
      )
      .select("id")
      .maybeSingle();
    if (error || !saved) throw new Error("The Content routine could not be saved.");
    return { id: String(saved.id), nextRunAt };
  }
  const { data: routine, error } = await db()
    .from("content_routines")
    .select("schedule,timezone")
    .eq("id", data.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !routine) throw new Error("This Content routine is unavailable.");
  const nextRunAt = data.paused
    ? null
    : nextContentRoutineRun(routine.schedule, routine.timezone).toISOString();
  await ownedMutation(
    db()
      .from("content_routines")
      .update({ enabled: !data.paused, next_run_at: nextRunAt })
      .eq("id", data.id)
      .eq("user_id", userId),
    "The Content routine could not be changed.",
  );
  return { id: data.id, paused: data.paused, nextRunAt };
}

export async function getMcpContentAgent(userId: string, threadId?: string) {
  await requireContentWorkspace(userId);
  if (!threadId) {
    const page = await listContentAgentThreadsForWorkspace(userId, { limit: 49 });
    return { threads: [page.agent, ...page.chats].slice(0, 50) };
  }
  uuid.parse(threadId);
  const [thread, messages] = await Promise.all([
    db()
      .from("content_agent_threads")
      .select("id,title,last_message_at,created_at")
      .eq("id", threadId)
      .eq("user_id", userId)
      .maybeSingle(),
    db()
      .from("content_agent_messages")
      .select("id,role,content,payload,created_at")
      .eq("thread_id", threadId)
      .eq("user_id", userId)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(100),
  ]);
  if (thread.error || !thread.data || messages.error)
    throw new Error("This Agent conversation is unavailable.");
  return { thread: thread.data, messages: messages.data || [] };
}

export async function manageMcpContentAgent(userId: string, input: unknown) {
  const data = agentMutationSchema.parse(input);
  await requireContentWorkspace(userId);
  if (data.action === "send_message") {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "content-agent-turn", userId);
    return runContentAgentTurn({ userId, threadId: data.threadId, text: data.text });
  }
  if (data.action === "approve_brain") return approveAgentBrainProposalForUser(userId, data);
  if (data.action === "approve_schedule") return approveAgentScheduleProposalForUser(userId, data);
  const { threadId, result } = await loadAssistantResult(userId, data.messageId);
  const draft = result.cards.find((card) => card.cardId === data.cardId && card.type === "draft");
  if (!draft || draft.type !== "draft") throw new Error("This draft is unavailable.");
  if (data.action === "save_draft") {
    draft.body = data.body;
    return ownedMutation(
      db()
        .from("content_agent_messages")
        .update({ payload: result })
        .eq("id", data.messageId)
        .eq("user_id", userId)
        .eq("role", "assistant"),
      "Draft changes could not be saved.",
    );
  }
  if (data.action === "regenerate_draft") {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "content-agent-turn", userId);
    return runContentAgentTurn({
      userId,
      threadId,
      text: `Regenerate the ${draft.platform} ${draft.format}. Keep the source facts. Feedback: ${data.reason}`,
    });
  }
  const { error } = await db()
    .from("content_agent_messages")
    .insert({
      user_id: userId,
      thread_id: threadId,
      role: "system_event",
      content: "Draft rejected.",
      payload: {
        feedback: {
          type: "rejected",
          messageId: data.messageId,
          cardId: data.cardId,
          reason: data.reason,
        },
      },
    });
  if (error) throw new Error("Draft feedback could not be saved.");
  return { rejected: true };
}

export async function getMcpContentDiscover(userId: string, creatorId?: string) {
  await requireContentWorkspace(userId, "discover");
  if (creatorId) {
    const { data: row, error } = await db()
      .from("creator_content_recommendations")
      .select("id,title,summary,source_url,source_published_at,source_retrieved_at,metadata")
      .eq("user_id", userId)
      .eq("id", uuid.parse(creatorId))
      .maybeSingle();
    if (error || !row) throw new Error("This stored recommendation could not be loaded.");
    return {
      creator: {
        author: typeof row.metadata?.author === "string" ? row.metadata.author : null,
        authorUrl: typeof row.metadata?.authorUrl === "string" ? row.metadata.authorUrl : null,
        authorAvatarUrl:
          typeof row.metadata?.authorAvatarUrl === "string" ? row.metadata.authorAvatarUrl : null,
      },
      recommendation: {
        id: row.id,
        title: row.title,
        summary: row.summary,
        sourceUrl: row.source_url,
        sourcePublishedAt: row.source_published_at,
        sourceRetrievedAt: row.source_retrieved_at,
      },
    };
  }
  const [discover, profile] = await Promise.all([
    readStoredDiscover(userId),
    db()
      .from("creator_content_profiles")
      .select(CONTENT_PROFILE_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (profile.error) throw new Error("Discover preferences could not be loaded.");
  return {
    discover,
    dataAccess: {
      tool: "read_workspace_data",
      collections: ["discover_items"],
      savedOnly: "Use savedOnly: true to fetch every stored bookmark, including older briefs.",
    },
    preferences: {
      ...(profile.data ? contentProfileFromRow(profile.data) : contentProfileSchema.parse({})),
      useBrainContext: profile.data?.discover_use_brain !== false,
    },
  };
}

export async function manageMcpContentDiscover(userId: string, input: unknown) {
  const data = discoverMutationSchema.parse(input);
  await requireContentWorkspace(userId, "discover");
  if (data.action === "refresh") return refreshContentDiscoverForUser(userId, data.force);
  if (data.action === "load_more") return loadMoreDiscoverForUser(userId, data);
  if (data.action === "save_preferences") {
    const { error } = await db().from("creator_content_profiles").upsert(
      {
        user_id: userId,
        niche_keywords: data.nicheKeywords,
        discover_use_brain: data.useBrainContext,
        language: data.language,
        region: data.region,
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error("Your Discover preferences could not be saved.");
    return { saved: true };
  }
  if (data.action === "track_creator") {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "discover-track", userId);
    const creators = await readDiscoverFollows(userId);
    if (
      creators.length >= 25 &&
      !creators.some((creator) => creator.profileUrl === data.profileUrl.profileUrl)
    )
      throw new Error("You can track up to 25 creators. Untrack one to add another.");
    const { data: row, error } = await db()
      .from("creator_discover_follows")
      .upsert(
        {
          user_id: userId,
          profile_url: data.profileUrl.profileUrl,
          platform: data.profileUrl.platform,
          name: data.name || data.profileUrl.name,
          topics: data.topics,
          active: true,
        },
        { onConflict: "user_id,profile_url" },
      )
      .select("id")
      .single();
    if (error || !row) throw new Error("This creator could not be tracked.");
    return { id: String(row.id) };
  }
  if (data.action === "untrack_creator")
    return ownedMutation(
      db()
        .from("creator_discover_follows")
        .update({ active: false })
        .eq("id", data.id)
        .eq("user_id", userId),
      "This creator could not be untracked.",
    );
  const { data: current, error: readError } = await db()
    .from("creator_content_recommendations")
    .select("feedback,metadata")
    .eq("id", data.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError || !current) throw new Error("This recommendation is unavailable.");
  if (data.action === "feedback") {
    const savedMetadata =
      current.feedback === "saved" || current.metadata?.saved === true
        ? { metadata: { ...current.metadata, saved: true } }
        : {};
    let result = await db()
      .from("creator_content_recommendations")
      .update({ ...savedMetadata, feedback: data.feedback, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (result.error && data.feedback === "liked")
      result = await db()
        .from("creator_content_recommendations")
        .update({ feedback: "saved", updated_at: new Date().toISOString() })
        .eq("id", data.id)
        .eq("user_id", userId)
        .select("id")
        .maybeSingle();
    if (result.error || !result.data) throw new Error("The recommendation could not be updated.");
    return { id: data.id, feedback: data.feedback };
  }
  if (data.action === "save_item") {
    await ownedMutation(
      db()
        .from("creator_content_recommendations")
        .update({
          feedback: "saved",
          metadata: { ...current.metadata, saved: true },
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.id)
        .eq("user_id", userId),
      "The recommendation could not be saved.",
    );
    return { id: data.id, saved: true };
  }
  const feedback = current.feedback === "saved" ? "pending" : current.feedback;
  await ownedMutation(
    db()
      .from("creator_content_recommendations")
      .update({
        feedback,
        metadata: { ...current.metadata, saved: false },
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", userId),
    "The recommendation could not be unsaved.",
  );
  return { id: data.id, feedback, saved: false };
}
