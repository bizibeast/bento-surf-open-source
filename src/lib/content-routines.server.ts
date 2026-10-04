/* eslint-disable @typescript-eslint/no-explicit-any -- Routine rows span new and existing tables. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getOrBuildTrendBrief } from "./content-briefs.server";
import { notifyContentDraftsReady } from "./content-notifications.server";
import { runContentAgentTurn } from "./content-agent.server";
import {
  missingPostingSlots,
  nextContentRoutineRun,
  type ContentRoutineSchedule,
  type ContentRoutineTemplate,
} from "./content-routines";
import type { ContentProfile } from "./content-brain";
import type { PostingSchedule, SchedulerPost } from "./social-scheduler";
import { recordContentEvent } from "./content-workspace-analytics.server";
import { syncActiveContentConnectionsForUser } from "./content-provider-adapters.server";

export type { ContentRoutineTemplate } from "./content-routines";

export type ContentRoutineRun = {
  id: string;
  routineId: string;
  userId: string;
  template: ContentRoutineTemplate;
  scheduledFor: string;
  timezone: string;
  schedule: ContentRoutineSchedule;
  platforms: string[];
};

export type ContentRoutineContext = {
  profile: Pick<ContentProfile, "nicheKeywords" | "language" | "region">;
  postingSchedule: PostingSchedule;
  posts: SchedulerPost[];
};

export type ContentRoutineServerDependencies = {
  claimRuns(limit?: number): Promise<ContentRoutineRun[]>;
  loadContext(userId: string): Promise<ContentRoutineContext>;
  refreshBrief(input: {
    nicheKeywords: string[];
    language: string;
    region: string;
    date: string;
  }): Promise<{ items: unknown[] }>;
  generateDraftBatch(input: {
    userId: string;
    platforms: string[];
    slots: Array<{ day: number; time: string; scheduledAt: string }>;
  }): Promise<number>;
  generateWeeklyReview(input: { userId: string }): Promise<number>;
  generateCustomRoutine?(input: {
    userId: string;
    instructions: string;
    platforms: string[];
  }): Promise<number>;
  notifyMorningDrafts?(run: ContentRoutineRun): Promise<number>;
  finishRun(input: {
    runId: string;
    status: "succeeded" | "failed";
    resultCount: number;
    error?: string | null;
    nextRunAt?: string | null;
  }): Promise<boolean>;
  cleanupExpiredMessages(): Promise<void>;
  syncKnowledge(userId: string): Promise<{ succeeded: number; failed: number }>;
  notifyDraftsReady(input: {
    userId: string;
    runId: string;
    draftCount: number;
    platforms: string[];
  }): Promise<unknown>;
};

function socialPostFromRow(row: any): SchedulerPost {
  return {
    id: row.id,
    body: row.body,
    title: row.title,
    scheduledAt: row.scheduled_at,
    timezone: row.timezone,
    status: row.status,
    media: Array.isArray(row.media) ? row.media : [],
    createdAt: row.created_at,
    targets: [],
  };
}

const defaultDependencies: ContentRoutineServerDependencies = {
  async claimRuns(limit = 25) {
    const db = supabaseAdmin as any;
    const { data: runs, error } = await db.rpc("claim_due_content_routines", {
      p_limit: limit,
      p_now: new Date().toISOString(),
    });
    if (error) throw new Error("Content routines could not be claimed.");
    if (!runs?.length) return [];
    const routineIds = [...new Set(runs.map((run: any) => run.routine_id))];
    const { data: routines, error: routineError } = await db
      .from("content_routines")
      .select("id,template,schedule,timezone,platforms")
      .in("id", routineIds);
    if (routineError) throw new Error("Content routine settings could not be loaded.");
    const byId = new Map((routines || []).map((routine: any) => [routine.id, routine]));
    return runs.flatMap((run: any): ContentRoutineRun[] => {
      const routine = byId.get(run.routine_id) as any;
      if (!routine) return [];
      return [
        {
          id: run.id,
          routineId: run.routine_id,
          userId: run.user_id,
          template: routine.template,
          scheduledFor: run.scheduled_for,
          timezone: routine.timezone,
          schedule: routine.schedule,
          platforms: routine.platforms || [],
        },
      ];
    });
  },
  async loadContext(userId) {
    const db = supabaseAdmin as any;
    const [profile, postingSchedule, posts] = await Promise.all([
      db
        .from("creator_content_profiles")
        .select("niche_keywords,language,region")
        .eq("user_id", userId)
        .maybeSingle(),
      db
        .from("social_posting_schedules")
        .select("timezone,slots,natural_offset")
        .eq("user_id", userId)
        .maybeSingle(),
      db
        .from("social_posts")
        .select("id,body,title,scheduled_at,timezone,status,media,created_at")
        .eq("user_id", userId)
        .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (profile.error || postingSchedule.error || posts.error) {
      throw new Error("Content routine context could not be loaded.");
    }
    return {
      profile: {
        nicheKeywords: profile.data?.niche_keywords || [],
        language: profile.data?.language || "en",
        region: profile.data?.region || "global",
      },
      postingSchedule: {
        timezone: postingSchedule.data?.timezone || "UTC",
        slots: postingSchedule.data?.slots || [],
        naturalOffset: Boolean(postingSchedule.data?.natural_offset),
      },
      posts: (posts.data || []).map(socialPostFromRow),
    };
  },
  refreshBrief: getOrBuildTrendBrief,
  async generateDraftBatch(input) {
    if (!input.slots.length) return 0;
    const result = await runContentAgentTurn({
      userId: input.userId,
      text: `Prepare exactly ${input.slots.length} platform-native drafts for ${input.platforms.join(", ") || "my connected platforms"}. Target these reviewed schedule slots: ${JSON.stringify(input.slots)}. Keep every result as a draft or schedule proposal; do not publish.`,
    });
    return result.result.cards.filter((card) => card.type === "draft").length;
  },
  async generateWeeklyReview(input) {
    const result = await runContentAgentTurn({
      userId: input.userId,
      text: "Review my last week of publishing consistency and reach. Summarize only provider-backed metrics and suggest three repeatable lessons.",
    });
    return result.result.cards.length || 1;
  },
  async generateCustomRoutine(input) {
    const result = await runContentAgentTurn({
      userId: input.userId,
      text: `Run this saved routine for ${input.platforms.join(", ") || "my connected platforms"}:\n${input.instructions}\nUse only my Brain and connected sources. Save outputs in this conversation for review. Do not publish, send messages, follow accounts, or change any schedule.`,
    });
    return result.result.cards.length || 1;
  },
  async notifyMorningDrafts(run) {
    const db = supabaseAdmin as any;
    const { data: prior, error: priorError } = await db
      .from("content_routine_runs")
      .select("scheduled_for")
      .eq("user_id", run.userId)
      .eq("routine_id", run.routineId)
      .eq("status", "succeeded")
      .lt("scheduled_for", run.scheduledFor)
      .order("scheduled_for", { ascending: false })
      .limit(1);
    const since =
      prior?.[0]?.scheduled_for ||
      new Date(new Date(run.scheduledFor).getTime() - 24 * 60 * 60_000).toISOString();
    const { data: batches, error } = await db
      .from("content_routine_runs")
      .select("result_count,content_routines!inner(template)")
      .eq("user_id", run.userId)
      .eq("status", "succeeded")
      .eq("content_routines.template", "fill_schedule")
      .gt("scheduled_for", since)
      .lte("scheduled_for", run.scheduledFor)
      .gt("result_count", 0)
      .limit(100);
    if (priorError || error) throw new Error("Ready draft batches could not be loaded.");
    const draftCount = (batches || []).reduce(
      (total: number, batch: any) => total + Number(batch.result_count || 0),
      0,
    );
    if (!draftCount) return 0;
    const notification = await notifyContentDraftsReady({
      userId: run.userId,
      runId: run.id,
      draftCount,
      platforms: run.platforms,
    });
    if (notification.email === "failed")
      throw new Error("The morning draft email could not be sent.");
    return draftCount;
  },
  async finishRun(input) {
    const { data, error } = await (supabaseAdmin as any).rpc("finish_content_routine_run", {
      p_run_id: input.runId,
      p_status: input.status,
      p_result_count: input.resultCount,
      p_error_message: input.error || null,
      p_next_run_at: input.nextRunAt || null,
    });
    if (error) throw new Error("Content routine completion could not be recorded.");
    return Boolean(data);
  },
  async cleanupExpiredMessages() {
    const db = supabaseAdmin as any;
    const { data } = await db
      .from("content_agent_messages")
      .select("id")
      .lte("expires_at", new Date().toISOString())
      .limit(100);
    const ids = (data || []).map((row: any) => row.id);
    if (ids.length) await db.from("content_agent_messages").delete().in("id", ids);
  },
  notifyDraftsReady: notifyContentDraftsReady,
  syncKnowledge: syncActiveContentConnectionsForUser,
};

export async function processContentRoutineRun(
  run: ContentRoutineRun,
  dependencies: ContentRoutineServerDependencies = defaultDependencies,
) {
  if (run.template === "morning_ready_email")
    return { resultCount: (await dependencies.notifyMorningDrafts?.(run)) || 0 };
  await dependencies.syncKnowledge(run.userId);
  const context = await dependencies.loadContext(run.userId);
  const scheduledFor = new Date(run.scheduledFor);
  if (run.template === "nightly_niche_brief") {
    const brief = await dependencies.refreshBrief({
      nicheKeywords: context.profile.nicheKeywords,
      language: context.profile.language,
      region: context.profile.region,
      date: scheduledFor.toISOString().slice(0, 10),
    });
    return { resultCount: brief.items.length };
  }
  if (run.template === "fill_schedule") {
    const until = new Date(scheduledFor.getTime() + 7 * 24 * 60 * 60_000);
    const slots = missingPostingSlots(context.postingSchedule, context.posts, {
      from: scheduledFor,
      until,
    });
    const resultCount = await dependencies.generateDraftBatch({
      userId: run.userId,
      platforms: run.platforms,
      slots,
    });
    return { resultCount };
  }
  if (run.template === "weekly_performance_review") {
    return { resultCount: await dependencies.generateWeeklyReview({ userId: run.userId }) };
  }
  if (
    run.template.startsWith("custom:") &&
    run.schedule.instructions &&
    dependencies.generateCustomRoutine
  ) {
    return {
      resultCount: await dependencies.generateCustomRoutine({
        userId: run.userId,
        instructions: run.schedule.instructions,
        platforms: run.platforms,
      }),
    };
  }
  throw new Error("This routine has no supported instructions.");
}

export async function processDueContentRoutines(
  dependencies: ContentRoutineServerDependencies = defaultDependencies,
) {
  await dependencies.cleanupExpiredMessages();
  const runs = await dependencies.claimRuns(25);
  let succeeded = 0;
  let failed = 0;
  let results = 0;
  for (const run of runs) {
    const nextRunAt = nextContentRoutineRun(
      run.schedule,
      run.timezone,
      new Date(run.scheduledFor),
    ).toISOString();
    try {
      const result = await processContentRoutineRun(run, dependencies);
      results += result.resultCount;
      succeeded += 1;
      await dependencies.finishRun({
        runId: run.id,
        status: "succeeded",
        resultCount: result.resultCount,
        nextRunAt,
      });
      void recordContentEvent(run.userId, "content_routine_run", {
        template: run.template,
        status: "succeeded",
        resultCount: result.resultCount,
      });
    } catch (error) {
      failed += 1;
      await dependencies.finishRun({
        runId: run.id,
        status: "failed",
        resultCount: 0,
        error: (error instanceof Error ? error.message : "Routine failed").slice(0, 1_000),
        nextRunAt,
      });
      void recordContentEvent(run.userId, "content_routine_run", {
        template: run.template,
        status: "failed",
        resultCount: 0,
      });
    }
  }
  return { claimed: runs.length, succeeded, failed, results };
}
