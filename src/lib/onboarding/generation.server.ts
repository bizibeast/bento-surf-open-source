import { withProviderBudgetWorkspace } from "../provider-budget.server";
import {
  buildEditorialBrief,
  type EditorialContext,
  type EditorialPlatform,
} from "../content-editorial";
import { generateEditorialDraft } from "../content-editorial.server";
import {
  buildManualCandidates,
  onboardingBriefSchema,
  onboardingCandidatesSchema,
  ONBOARDING_OUTPUT_PLATFORMS,
  hasUnsupportedOnboardingDrafts,
  type OnboardingBrief,
  type OnboardingCandidates,
} from "./brief";
import { onboardingDb } from "./session.server";

type OnboardingSource = {
  provider: string;
  caption: string | null;
  remote_post_url: string | null;
  published_at?: string | null;
};
/** Before trial activation, use only the approved preparation and owned imported samples. */
export async function generateOnboardingDrafts(
  brief: OnboardingBrief,
  candidates: OnboardingCandidates,
  sources: OnboardingSource[],
  generate = generateEditorialDraft,
  deadline = Date.now() + 90_000,
  preserveExisting = true,
) {
  if (!(ONBOARDING_OUTPUT_PLATFORMS as readonly string[]).includes(brief.platform))
    return {
      ...candidates,
      warning:
        "Choose X text, LinkedIn text, or Instagram carousel for your starter drafts. Your imported source account and history stay connected.",
    };
  if (preserveExisting && hasUnsupportedOnboardingDrafts(candidates))
    return {
      ...candidates,
      warning:
        "Your earlier drafts remain saved. Choose X text, LinkedIn text, or Instagram carousel and refresh your starter drafts to prepare supported structured output.",
      retry: false,
    };
  const context: EditorialContext = {
    platform: brief.platform as EditorialPlatform,
    request: `Prepare an original useful draft for ${brief.audience} about ${brief.expertise}. Goal: ${brief.goal}. Language: ${brief.language}. Use a distinct argument and reader decision for each of the three starter drafts.`,
    brain: candidates.brain.map((item) => ({ ...item, status: "confirmed" })),
    sources: [
      ...candidates.brain
        .filter((item) => item.kind === "profile")
        .map((item, index) => ({
          id: `profile-${index}`,
          title: item.title,
          text: item.content,
          occurredAt: null,
          external: false,
        })),
      ...sources
        .filter((item) => item.caption)
        .map((item, index) => ({
          id: `source-${index}`,
          title: `Creator's ${item.provider} post`,
          text: item.caption!,
          occurredAt: item.published_at || null,
          url: item.remote_post_url,
          external: false,
        })),
    ],
    representativePosts: sources
      .filter((item) => item.caption)
      .map((item, index) => ({
        id: `source-${index}`,
        body: item.caption!,
        createdAt: item.published_at || undefined,
      })),
    recentOutputs: candidates.drafts.map((draft, index) => ({
      id: `existing-starter-${index}`,
      body: [
        draft.body,
        ...(draft.slides || []).map((slide) => `${slide.heading} ${slide.body}`),
      ].join("\n"),
      createdAt: new Date().toISOString(),
    })),
  };
  const drafts: OnboardingCandidates["drafts"] = preserveExisting ? [...candidates.drafts] : [];
  let warning: string | null = null;
  let retry = false;
  for (let index = drafts.length; index < 3; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      warning =
        "Draft checking timed out. Your completed drafts are saved; retry to prepare all three.";
      retry = true;
      break;
    }
    const result = await generate(buildEditorialBrief(context), {
      timeoutMs: Math.min(45_000, remaining),
    });
    if (result.status !== "ready" || result.card.type !== "draft") {
      warning = result.message;
      retry = result.status === "retry";
      break;
    }
    const { card } = result;
    drafts.push(
      onboardingCandidatesSchema.shape.drafts.element.parse({
        ...card,
        title: card.title || "Starter draft",
      }),
    );
    context.recentOutputs!.push({
      id: `starter-${index}`,
      body: [
        card.body,
        ...(card.slides || []).map((slide) => `${slide.heading} ${slide.body}`),
      ].join("\n"),
      createdAt: new Date().toISOString(),
    });
  }
  return { ...candidates, drafts, warning, retry };
}

async function processOnboardingGenerationScoped(workspaceId: string) {
  const { data, error } = await onboardingDb.rpc("claim_onboarding_generation", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error("Your preparation could not be started.");
  const session = data?.[0];
  if (!session) return;
  try {
    const deadline = Math.min(
      Date.now() + 90_000,
      Date.parse(session.job_lease_until || "") - 10_000 || Infinity,
    );
    const brief = onboardingBriefSchema.parse(session.brief);
    const candidates = session.candidates
      ? onboardingCandidatesSchema.parse(session.candidates)
      : buildManualCandidates(brief);
    const { data: sources, error: sourceError } = await onboardingDb
      .from("social_content_insights")
      .select("provider,caption,remote_post_url,published_at")
      .eq("user_id", workspaceId)
      .eq("connection_id", brief.primaryConnectionId ?? "00000000-0000-0000-0000-000000000000")
      .order("published_at", { ascending: false })
      .limit(20);
    if (sourceError) throw new Error("Connected post samples could not be read.");
    const generated = await generateOnboardingDrafts(
      brief,
      candidates,
      sources || [],
      generateEditorialDraft,
      deadline,
      // The claim increments attempts. A deliberate refresh starts at one; recovery retains partial work.
      session.job_attempts > 1,
    );
    const parsed = onboardingCandidatesSchema.parse(generated);
    const { error: saveError } = await onboardingDb
      .from("onboarding_sessions")
      .update({
        candidates: parsed,
        job_status: "retry" in generated && generated.retry ? "failed" : "ready",
        job_error: parsed.warning,
        job_lease_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("revision", session.revision)
      .eq("job_lease", session.job_lease);
    if (saveError) throw new Error("Prepared drafts could not be saved.");
  } catch {
    console.error("[onboarding] generation failed", { workspaceId });
    const { error: saveError } = await onboardingDb
      .from("onboarding_sessions")
      .update({
        job_status: "failed",
        job_error:
          "Draft generation is unavailable. Your answers are saved; retry or continue with your reviewed page and Brain.",
        job_lease_until: null,
      })
      .eq("workspace_id", workspaceId)
      .eq("revision", session.revision)
      .eq("job_lease", session.job_lease);
    if (saveError) throw new Error("Preparation recovery could not be saved.");
  }
}

export async function processDueOnboardingGenerations() {
  const { error: recoveryError } = await onboardingDb
    .from("onboarding_sessions")
    .update({
      job_status: "failed",
      job_error:
        "Preparation was interrupted twice. Your answers and core Brain are saved; continue manually or retry within your allowance.",
      job_lease_until: null,
    })
    .eq("job_status", "running")
    .gte("job_attempts", 2)
    .lt("job_lease_until", new Date().toISOString());
  if (recoveryError) throw new Error("Interrupted preparation could not be recovered.");
  const { data, error } = await onboardingDb
    .from("onboarding_sessions")
    .select("workspace_id")
    .or(
      `job_status.eq.queued,and(job_status.eq.running,job_lease_until.lt.${new Date().toISOString()})`,
    )
    .lt("job_attempts", 2)
    .limit(1);
  if (error) throw new Error(error.message);
  for (const session of data ?? []) await processOnboardingGeneration(session.workspace_id);
}

export function processOnboardingGeneration(workspaceId: string) {
  return withProviderBudgetWorkspace(workspaceId, () =>
    processOnboardingGenerationScoped(workspaceId),
  );
}
