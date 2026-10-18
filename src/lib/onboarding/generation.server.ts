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
import { prepareOnboardingInstagramPhoto } from "./media.server";
import { loadOnboardingResearch, type OnboardingSource } from "./research.server";
import { prepareOnboardingBrain } from "./personalization.server";

export function citedInstagramPhoto(
  draft: OnboardingCandidates["drafts"][number],
  sources: OnboardingSource[],
) {
  if (draft.platform !== "linkedin") return undefined;
  return sources
    .filter((source) => source.caption)
    .find(
      (source, index) =>
        source.id &&
        source.provider === "instagram" &&
        ["image", "carousel"].includes(source.content_type || "") &&
        draft.editorial?.sourceIds.includes(`source-${index}`),
    )?.id;
}
/** Before trial activation, use only the approved preparation and owned imported samples. */
export async function generateOnboardingDrafts(
  brief: OnboardingBrief,
  candidates: OnboardingCandidates,
  sources: OnboardingSource[],
  generate = generateEditorialDraft,
  deadline = Date.now() + 90_000,
  preserveExisting = true,
  photoPostId?: string | null,
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
  const photoSourceIndex =
    brief.platform === "linkedin" && photoPostId
      ? sources.filter((source) => source.caption).findIndex((source) => source.id === photoPostId)
      : -1;
  const context: EditorialContext = {
    platform: brief.platform as EditorialPlatform,
    request: `Prepare one original useful starter draft for ${brief.audience} about ${brief.expertise}. Goal: ${brief.goal}. Language: ${brief.language}. Develop one specific argument and useful reader decision in the creator's voice.${photoSourceIndex >= 0 ? ` Adapt the supported experience or lesson from source-${photoSourceIndex} into an original LinkedIn post and cite that source. Its owned Instagram photo can accompany the draft. Do not describe unseen image contents or invent new events.` : ""}`,
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
        }))
        // Keep the photo's story in the bounded evidence pack; other samples still teach voice.
        .filter((_, index) => photoSourceIndex < 0 || index === photoSourceIndex),
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
  for (let index = drafts.length; index < 1; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      warning = "Draft checking timed out. Your Brain is saved; retry to prepare your first draft.";
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
    let candidates = session.candidates
      ? onboardingCandidatesSchema.parse(session.candidates)
      : buildManualCandidates(brief);
    const research = await loadOnboardingResearch(workspaceId);
    const sources = research.posts;
    const saveCheckpoint = async (value: OnboardingCandidates) => {
      const saved = await onboardingDb
        .from("onboarding_sessions")
        .update({ candidates: value })
        .eq("workspace_id", workspaceId)
        .eq("revision", session.revision)
        .eq("job_lease", session.job_lease)
        .select("revision")
        .maybeSingle();
      if (saved.error || !saved.data)
        throw new Error("Your preparation changed or could not be saved.");
    };
    candidates = await prepareOnboardingBrain(
      brief,
      candidates,
      research,
      session.generation_count,
      session.job_attempts > 1,
      deadline,
      saveCheckpoint,
    );
    const generated = await generateOnboardingDrafts(
      brief,
      candidates,
      sources || [],
      generateEditorialDraft,
      deadline,
      // The claim increments attempts. A deliberate refresh starts at one; recovery retains partial work.
      session.job_attempts > 1,
      research.photoPostId,
    );
    let parsed = onboardingCandidatesSchema.parse(generated);
    parsed = {
      ...parsed,
      drafts: parsed.drafts.map((draft) => ({
        // Existing checked drafts retain their original source mapping on recovery.
        ...draft,
        photoSourcePostId:
          draft.photoSourcePostId ||
          (session.job_attempts > 1 &&
          candidates.drafts.some(
            (previous) => previous.body === draft.body && previous.platform === draft.platform,
          )
            ? undefined
            : citedInstagramPhoto(draft, sources)),
      })),
    };
    // Save the checked copy before downloading a photo. Recovery retains the same source post.
    const checkpoint = await onboardingDb
      .from("onboarding_sessions")
      .update({ candidates: parsed })
      .eq("workspace_id", workspaceId)
      .eq("revision", session.revision)
      .eq("job_lease", session.job_lease)
      .select("revision")
      .maybeSingle();
    if (checkpoint.error) throw new Error("Your checked draft could not be saved.");
    if (!checkpoint.data) return;
    for (const draft of parsed.drafts) {
      if (!draft.photoSourcePostId || draft.mediaIds?.length || draft.platform !== "linkedin")
        continue;
      try {
        const photo = await prepareOnboardingInstagramPhoto(workspaceId, draft.photoSourcePostId);
        if (photo) Object.assign(draft, photo);
        else
          draft.mediaNote =
            "No photo was attached. You can add an owned image in the draft editor.";
      } catch {
        draft.mediaNote =
          "Your draft is saved. Its Instagram photo could not be prepared; choose an image in the draft editor.";
      }
    }
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
