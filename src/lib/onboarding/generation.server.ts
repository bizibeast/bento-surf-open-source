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
  ONBOARDING_GOALS,
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
const clip = (value: string, max: number) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max).trimEnd();
};

/** Answers the creator already typed. No metrics, stories, or sources they did not supply. */
export function groundedOnboardingDraft(
  brief: OnboardingBrief,
): OnboardingCandidates["drafts"][number] {
  const expertise = clip(brief.expertise, 180) || "the work you do";
  const audience = clip(brief.audience, 180) || "the people you want to help";
  const goal =
    ONBOARDING_GOALS.find((item) => item.id === brief.goal)?.label || "Build my online presence";
  const offer = clip(brief.offer, 180);
  const rationale = "Starter from your onboarding answers. No added facts, metrics, or stories.";
  if (brief.platform === "instagram") {
    return {
      title: clip(expertise, 80) || "Starter note",
      body: clip(`A starting note for ${audience} about ${expertise}.`, 500),
      platform: "instagram",
      format: "carousel",
      slides: [
        { heading: "Who it is for", body: clip(audience, 360) },
        { heading: "What I share", body: clip(expertise, 360) },
        ...(offer ? [{ heading: "Offer I described", body: offer }] : []),
        { heading: "First goal", body: clip(goal, 360) },
      ],
      rationale,
    };
  }
  const lines = [
    `A starting note for ${audience}.`,
    `What I want to share: ${expertise}.`,
    offer ? `Offer I already described: ${offer}.` : "",
    `First goal I chose: ${goal}.`,
    "This uses only those answers. It does not add results or stories.",
  ].filter(Boolean);
  let body = lines.join("\n\n");
  if (brief.platform === "twitter" && body.length > 280)
    body =
      `I want to share ${clip(expertise, 80)} with ${clip(audience, 80)}. Goal: ${clip(goal, 40)}.`.slice(
        0,
        280,
      );
  return {
    title: clip(expertise, 80) || "Starter note",
    body,
    platform: brief.platform,
    format: "post",
    rationale,
  };
}

const starterWarnings = {
  timeout:
    "Draft checking ran out of time. This starter uses only the answers you already gave. Edit it, try again, or continue and publish your page.",
  provider:
    "I couldn't finish generating and checking this draft. This starter uses only the answers you already gave. You can edit it, try again, or continue and publish your page.",
  evidence:
    "I couldn't verify a model draft without adding facts. This starter uses only the answers you already gave. Edit it, try again, or continue and publish your page.",
  quality:
    "I couldn't settle a checked model draft. This starter uses only the answers you already gave. Edit it, try again, or continue and publish your page.",
} as const;

function withGroundedStarter(
  candidates: OnboardingCandidates,
  brief: OnboardingBrief,
  warning: string,
  reason: string,
) {
  console.warn("[onboarding] draft fallback", { reason });
  return {
    ...candidates,
    drafts: [groundedOnboardingDraft(brief)],
    warning,
    retry: false as const,
  };
}

function starterWarning(reason: string | undefined, message: string) {
  if (/credits|connection needs attention/.test(message))
    return { warning: message, reason: "provider" };
  if (reason === "timeout" || reason === "evidence" || reason === "quality")
    return { warning: starterWarnings[reason], reason };
  return { warning: starterWarnings.provider, reason: "provider" };
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
  retryDelayMs = 1_500,
) {
  if (!(ONBOARDING_OUTPUT_PLATFORMS as readonly string[]).includes(brief.platform))
    return {
      ...candidates,
      warning:
        "Choose X text, LinkedIn text, or Instagram carousel for your starter drafts. Your imported source account and history stay connected.",
      retry: false,
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
  for (let index = drafts.length; index < 1; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return withGroundedStarter(candidates, brief, starterWarnings.timeout, "timeout");
    let result = await generate(buildEditorialBrief(context), {
      timeoutMs: Math.min(80_000, remaining),
    });
    // One paid retry after a short pause. A finished failure does not requeue itself.
    if (result.status === "retry" && deadline - Date.now() > 15_000) {
      const pause = Math.min(retryDelayMs, Math.max(0, deadline - Date.now() - 15_000));
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      if (deadline - Date.now() > 5_000)
        result = await generate(buildEditorialBrief(context), {
          timeoutMs: Math.min(80_000, deadline - Date.now()),
        });
    }
    if (result.status !== "ready" || result.card.type !== "draft") {
      const fallback = starterWarning(result.reason, result.message);
      return withGroundedStarter(
        { ...candidates, drafts },
        brief,
        fallback.warning,
        fallback.reason,
      );
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
  return { ...candidates, drafts, warning: null, retry: false };
}

async function processOnboardingGenerationScoped(workspaceId: string) {
  const { data, error } = await onboardingDb.rpc("claim_onboarding_generation", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error("Your preparation could not be started.");
  const session = data?.[0];
  if (!session) return;
  try {
    // Brain can use up to 110s. The draft then gets the rest inside the 3 minute lease.
    const deadline = Math.min(
      Date.now() + 150_000,
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
