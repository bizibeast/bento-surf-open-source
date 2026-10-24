import { checkoutEligibility } from "../billing-checkout.server";
import { resolvePublicUsername } from "../username-alias.server";
import { indexNowUrlsForProfile, notifyIndexNow } from "../indexnow.server";
import { clearPublicProfileCache } from "../public-profile-cache.server";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPlan, isSelfHostedEdition, requirePlanEntitlement } from "../plan.server";
import { SOCIAL_CONNECTION_LIST_LIMIT } from "../large-table-columns";
import { contentProfileToRow } from "../content-brain";
import { enforceRequestRateLimit } from "../request-security.server";
import { parsePublicHttpUrl, safeMediaUrl } from "../safe-url";
import {
  ONBOARDING_OUTPUT_PLATFORMS,
  continueWithoutOnboardingDrafts,
  hasUnsupportedOnboardingDrafts,
  buildManualCandidates,
  onboardingBriefSchema,
  onboardingCandidatesSchema,
  onboardingContentProfile,
  preparationReady,
  hasCurrentOnboardingBrain,
  reconcileOnboardingBrain,
  stampOnboardingBrain,
} from "./brief";
import {
  onboardingDb as db,
  readOnboardingSession,
  requireOnboardingPreview,
  sessionView,
} from "./session.server";
import { processOnboardingGeneration } from "./generation.server";
import { loadOnboardingEvidence } from "./evidence.server";
import { carryOnboardingDraftMedia, validateOnboardingDraftMedia } from "./media.server";

export const getOnboarding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    let session = await readOnboardingSession(context.userId);
    const { data: profile, error } = await db
      .from("profiles")
      .select(
        "username,display_name,bio,avatar_url,account_timezone,trial_ends_at,page_published,onboarded,billing_catalog",
      )
      .eq("id", context.userId)
      .single();
    if (error) throw new Error("Your workspace could not be loaded.");
    if (!session) {
      const brief = onboardingBriefSchema.parse({
        displayName: profile.display_name ?? "",
        username: profile.username ?? "",
        bio: profile.bio ?? "",
        avatarUrl: profile.avatar_url ?? "",
        timezone: profile.account_timezone ?? "UTC",
        publishPage: profile.onboarded && profile.page_published,
      });
      const { error: createError } = await db
        .from("onboarding_sessions")
        .upsert(
          { workspace_id: context.userId, auth_user_id: context.authUserId, brief },
          { onConflict: "workspace_id", ignoreDuplicates: true },
        );
      if (createError) throw new Error("Your setup could not be saved.");
      session = await readOnboardingSession(context.userId);
    }
    const { data: connections, error: connectionError } = await db
      .from("social_connections")
      .select("id,provider,provider_handle,provider_display_name,provider_avatar_url,status")
      .eq("user_id", context.userId)
      .eq("status", "active")
      .limit(SOCIAL_CONNECTION_LIST_LIMIT);
    if (connectionError) throw new Error("Connected accounts could not be loaded.");
    return {
      session: sessionView(session),
      connections: (connections ?? []) as Array<{
        id: string;
        provider: string;
        provider_handle: string;
        provider_display_name: string;
        provider_avatar_url: string | null;
      }>,
      plan: await getPlan(context.userId),
      trialEndsAt: profile.trial_ends_at as string | null,
      currentUsername: profile.username as string | null,
      selfHosted: isSelfHostedEdition(),
      trialEligible: isSelfHostedEdition()
        ? false
        : (await checkoutEligibility(context.authUserId, context.userId)).trialEligible,
    };
  });

export const saveOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        revision: z.number().int().min(0),
        step: z.number().int().min(0).max(5),
        brief: onboardingBriefSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const session = await requireOnboardingPreview(context.userId);
    if (session.revision !== data.revision)
      throw new Error("Your setup changed in another tab. Reload to use the latest answers.");
    const changed =
      JSON.stringify(onboardingBriefSchema.parse(session.brief)) !== JSON.stringify(data.brief);
    const priorBrief = onboardingBriefSchema.parse(session.brief);
    const contextKeys = [
      "displayName",
      "expertise",
      "audience",
      "offer",
      "goal",
      "voice",
      "writingSample",
      "platform",
      "postsPerWeek",
      "language",
      "timezone",
    ] as const;
    const contextChanged = contextKeys.some((key) => priorBrief[key] !== data.brief[key]);
    let retainedCandidates =
      session.candidates && !contextChanged
        ? {
            ...session.candidates,
            brain: session.candidates.brain.map((item: { kind: string }) =>
              item.kind === "profile" && priorBrief.bio !== data.brief.bio
                ? buildManualCandidates(data.brief).brain[0]
                : item,
            ),
          }
        : session.candidates?.deferredDrafts?.length || session.candidates?.deferredBrain?.length
          ? onboardingCandidatesSchema.parse({
              ...buildManualCandidates(data.brief),
              // Answer changes invalidate active preparation, not the archived copy.
              deferredDrafts: session.candidates.deferredDrafts,
              deferredBrain: session.candidates.deferredBrain,
              warning:
                "Your answers changed. Review your updated Brain and prepare new drafts, or continue without a starter batch. Your earlier draft copy remains saved in your preparation download.",
            })
          : null;
    if (
      retainedCandidates &&
      session.candidates &&
      !contextChanged &&
      hasCurrentOnboardingBrain(onboardingCandidatesSchema.parse(session.candidates))
    )
      retainedCandidates = stampOnboardingBrain(retainedCandidates, "creator_review");
    const { data: saved, error } = await db
      .from("onboarding_sessions")
      .update({
        brief: data.brief,
        step: data.step,
        revision: session.revision + 1,
        updated_at: new Date().toISOString(),
        ...(changed
          ? {
              candidates: retainedCandidates,
              status: "draft",
              approved_revision: null,
              job_status: "idle",
              job_lease: null,
            }
          : session.status === "prepared" && session.approved_revision !== null
            ? { approved_revision: session.revision + 1 }
            : {}),
      })
      .eq("workspace_id", context.userId)
      .eq("revision", data.revision)
      .select("*")
      .maybeSingle();
    if (error || !saved) throw new Error("Your answers could not be saved. Reload and try again.");
    return sessionView(saved);
  });

export const importOnboardingSocial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireOnboardingPreview(context.userId);
    const { data: source, error } = await db
      .from("social_connections")
      .select("id,provider,provider_handle,provider_display_name,provider_avatar_url,metadata")
      .eq("user_id", context.userId)
      .eq("id", data.connectionId)
      .eq("status", "active")
      .single();
    if (error) throw new Error("Choose a connected account in this workspace.");
    const { data: posts, error: postsError } = await db
      .from("social_content_insights")
      .select("caption")
      .eq("user_id", context.userId)
      .eq("connection_id", data.connectionId)
      .order("published_at", { ascending: false })
      .limit(3);
    if (postsError) throw new Error("Imported posts could not be read.");
    const bases: Record<string, string> = {
      instagram: "https://instagram.com/",
      twitter: "https://x.com/",
      threads: "https://www.threads.net/@",
      tiktok: "https://www.tiktok.com/@",
      youtube: "https://www.youtube.com/@",
    };
    const profileUrl =
      bases[source.provider] && source.provider_handle
        ? bases[source.provider] + encodeURIComponent(source.provider_handle.replace(/^@/, ""))
        : "";
    const metadata = source.metadata?.profile ?? source.metadata ?? {};
    const bio =
      typeof metadata.biography === "string"
        ? metadata.biography
        : typeof metadata.bio === "string"
          ? metadata.bio
          : "";
    return {
      displayName: String(source.provider_display_name || source.provider_handle || "").slice(
        0,
        60,
      ),
      avatarUrl: safeMediaUrl(source.provider_avatar_url) ? String(source.provider_avatar_url) : "",
      bio: bio.slice(0, 280),
      primaryConnectionId: data.connectionId,
      links:
        profileUrl && parsePublicHttpUrl(profileUrl)
          ? [{ title: String(source.provider), url: profileUrl }]
          : [],
      writingSample: (posts ?? [])
        .map((post: { caption: string | null }) => post.caption ?? "")
        .join("\n\n")
        .slice(0, 4000),
      importedPosts: posts?.length ?? 0,
    };
  });

export const prepareOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ revision: z.number().int(), generate: z.boolean().default(true) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "onboarding-prepare",
      context.userId,
    );
    const session = await requireOnboardingPreview(context.userId);
    if (session.revision !== data.revision) throw new Error("Reload your latest answers first.");
    if (["queued", "running"].includes(session.job_status)) return sessionView(session);
    const brief = onboardingBriefSchema.parse(session.brief);
    if (!brief.displayName || !brief.expertise || !brief.audience)
      throw new Error("Add your name, expertise, and audience first.");
    if (
      data.generate &&
      !(ONBOARDING_OUTPUT_PLATFORMS as readonly string[]).includes(brief.platform)
    )
      throw new Error(
        "Choose X text, LinkedIn text, or Instagram carousel before generating starter drafts. Your source account and imported history stay connected.",
      );
    const retryFailed = session.job_status === "failed" && session.job_attempts < 2;
    if (data.generate && !retryFailed && session.generation_count >= 2)
      throw new Error(
        "You've used your starter generation allowance. You can still edit and use your preparation.",
      );
    const evidence = await loadOnboardingEvidence(context.userId);
    const { data: saved, error } = await db
      .from("onboarding_sessions")
      .update({
        candidates: {
          ...(data.generate
            ? (session.candidates ?? buildManualCandidates(brief))
            : continueWithoutOnboardingDrafts(
                session.candidates
                  ? onboardingCandidatesSchema.parse(session.candidates)
                  : buildManualCandidates(brief),
              )),
          evidence,
        },
        status: "draft",
        approved_revision: null,
        job_status: data.generate ? "queued" : "ready",
        job_error: null,
        job_attempts: retryFailed ? session.job_attempts : 0,
        generation_count: session.generation_count + (data.generate && !retryFailed ? 1 : 0),
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", context.userId)
      .eq("revision", data.revision)
      .eq("generation_count", session.generation_count)
      .select("*")
      .maybeSingle();
    if (error || !saved) throw new Error("Preparation is already running or your answers changed.");
    if (data.generate) await processOnboardingGeneration(context.userId);
    return sessionView(await readOnboardingSession(context.userId));
  });

export const approveOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        revision: z.number().int(),
        candidates: onboardingCandidatesSchema,
        allowPartial: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const session = await requireOnboardingPreview(context.userId);
    if (session.revision !== data.revision || ["running", "queued"].includes(session.job_status))
      throw new Error("Wait for preparation or reload your latest answers.");
    const savedCandidates = reconcileOnboardingBrain(
      onboardingBriefSchema.parse(session.brief),
      onboardingCandidatesSchema.parse(session.candidates),
    );
    if (JSON.stringify(savedCandidates) !== JSON.stringify(data.candidates))
      throw new Error("Save your latest Brain and draft edits before approving them.");
    const owner = await resolvePublicUsername(db, session.brief.username);
    await validateOnboardingDraftMedia(context.userId, savedCandidates);
    if (owner && owner.userId !== context.userId)
      throw new Error("That username is taken. Choose another link before checkout.");
    if (!preparationReady(onboardingBriefSchema.parse(session.brief), data.candidates))
      throw new Error("Review your page, audience, voice and strategy first.");
    if (hasUnsupportedOnboardingDrafts(data.candidates))
      throw new Error(
        "Your earlier preparation is saved. Choose X text, LinkedIn text, or Instagram carousel and prepare supported structured starter drafts before approving.",
      );
    if (!data.candidates.drafts.length && !data.allowPartial)
      throw new Error("Confirm continuing without starter drafts, or retry generation.");
    const { data: saved, error } = await db
      .from("onboarding_sessions")
      .update({
        candidates: data.candidates,
        approved_revision: data.revision,
        status: "prepared",
        step: 5,
      })
      .eq("workspace_id", context.userId)
      .eq("revision", data.revision)
      .select("*")
      .maybeSingle();
    if (error || !saved) throw new Error("Your review could not be saved.");
    return sessionView(saved);
  });

export const editOnboardingCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ revision: z.number().int(), candidates: onboardingCandidatesSchema }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const session = await requireOnboardingPreview(context.userId);
    if (session.revision !== data.revision || ["running", "queued"].includes(session.job_status))
      throw new Error("Wait for preparation or reload the latest version.");
    const previous = onboardingCandidatesSchema.parse(session.candidates);
    const safePrevious = reconcileOnboardingBrain(
      onboardingBriefSchema.parse(session.brief),
      previous,
    );
    const brainEdited = JSON.stringify(previous.brain) !== JSON.stringify(data.candidates.brain);
    const sameSafeBrain =
      JSON.stringify(safePrevious.brain) === JSON.stringify(data.candidates.brain);
    const { data: saved, error } = await db
      .from("onboarding_sessions")
      .update({
        candidates: stampOnboardingBrain(
          onboardingCandidatesSchema.parse({
            ...data.candidates,
            brain: brainEdited ? data.candidates.brain : safePrevious.brain,
            brainEvidence: safePrevious.brainEvidence,
            evidence: session.candidates?.evidence,
            personalization: safePrevious.personalization,
            deferredBrain: safePrevious.deferredBrain,
            // The archive is server-owned; older clients may omit this optional field.
            deferredDrafts: [
              ...new Map(
                [
                  ...(safePrevious.deferredDrafts || []),
                  ...(!sameSafeBrain ? data.candidates.drafts : []),
                ].map((draft) => [JSON.stringify(draft), draft]),
              ).values(),
            ],
            drafts: sameSafeBrain
              ? data.candidates.drafts.map((draft, index) => ({
                  ...draft,
                  mediaIds: session.candidates?.drafts[index]?.mediaIds,
                  mediaPreview: session.candidates?.drafts[index]?.mediaPreview,
                  photoSourcePostId: session.candidates?.drafts[index]?.photoSourcePostId,
                  mediaNote: session.candidates?.drafts[index]?.mediaNote,
                }))
              : [],
            warning: sameSafeBrain
              ? data.candidates.warning
              : "Your Brain changed. Refresh drafts to use this context, or continue without a starter batch.",
          }),
          brainEdited ? "creator_review" : safePrevious.brainEvidence!.method,
        ),
        revision: session.revision + 1,
        approved_revision: null,
        status: "draft",
      })
      .eq("workspace_id", context.userId)
      .eq("revision", data.revision)
      .select("*")
      .maybeSingle();
    if (error || !saved) throw new Error("Your edits could not be saved.");
    return sessionView(saved);
  });

export const publishOnboardingPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePlanEntitlement(
      context.userId,
      "customFonts",
      "An active hosted plan is required to publish your page.",
    );
    const session = await readOnboardingSession(context.userId);
    if (session?.status !== "applied") throw new Error("Activate your prepared page first.");
    const { error } = await db
      .from("profiles")
      .update({ page_published: true })
      .eq("id", context.userId);
    if (error) throw new Error("Your page could not be published.");
    const { error: sessionError } = await db
      .from("onboarding_sessions")
      .update({ brief: { ...session.brief, publishPage: true } })
      .eq("workspace_id", context.userId);
    if (sessionError)
      throw new Error("Publication status could not be saved. Reload to check your page.");
    await clearPublicProfileCache(session.brief.username);
    await notifyIndexNow(
      indexNowUrlsForProfile(
        process.env.VITE_PUBLIC_URL || "http://localhost:8080",
        session.brief.username,
      ),
      process.env,
    );
    return sessionView(await readOnboardingSession(context.userId));
  });

export const activateOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePlanEntitlement(
      context.userId,
      "customFonts",
      "Your card checkout is still being verified. Your preparation is saved.",
    );
    const session = await readOnboardingSession(context.userId);
    if (!session) throw new Error("Complete your preparation first.");
    if (session.status !== "applied" && session.candidates) {
      const candidates = onboardingCandidatesSchema.parse(session.candidates);
      const safe = reconcileOnboardingBrain(onboardingBriefSchema.parse(session.brief), candidates);
      if (JSON.stringify(safe.brain) !== JSON.stringify(candidates.brain))
        throw new Error(
          "Your earlier generated Brain is saved for review. Review the current starter notes before activating.",
        );
    }
    if (
      session.status === "prepared" &&
      session.candidates &&
      typeof session.approved_revision === "number" &&
      session.approved_revision < session.revision
    ) {
      // Earlier versions advanced the revision on step-only saves without
      // invalidating the prepared review. Content edits set status to draft.
      const { data: reconciled, error: reconcileError } = await db
        .from("onboarding_sessions")
        .update({ approved_revision: session.revision })
        .eq("workspace_id", context.userId)
        .eq("status", "prepared")
        .eq("revision", session.revision)
        .eq("approved_revision", session.approved_revision)
        .select("revision")
        .maybeSingle();
      if (reconcileError || !reconciled)
        throw new Error("Your preparation changed. Review it again before activating.");
    }
    const { error } = await db.rpc("apply_onboarding_preparation", {
      p_workspace_id: context.userId,
      p_revision: session.revision,
      p_content_profile: contentProfileToRow(
        onboardingContentProfile(onboardingBriefSchema.parse(session.brief)),
      ),
    });
    if (error) throw new Error(error.message);
    if (session.candidates?.drafts.some((draft: { mediaIds?: string[] }) => draft.mediaIds?.length))
      await carryOnboardingDraftMedia(context.userId, session.revision);
    await clearPublicProfileCache(session.brief.username);
    return sessionView(await readOnboardingSession(context.userId));
  });

/** Read-only ownership check deliberately does not require a paid entitlement. */
export const exportOnboardingContent = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { readOnboardingExport } = await import("./export.server");
    const [content, session] = await Promise.all([
      readOnboardingExport(context.userId),
      readOnboardingSession(context.userId),
    ]);
    return JSON.stringify(
      { ...content, brief: session?.brief ?? null, preparation: session?.candidates ?? null },
      null,
      2,
    );
  });
