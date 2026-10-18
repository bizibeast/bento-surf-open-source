import { onboardingDb as db } from "./session.server";
import { processContentMediaImportMessage } from "../content-media.server";
import { resolveOwnedAgentMedia } from "../content-agent-media.server";
import { parsePublicHttpUrl } from "../safe-url";
import type { OnboardingCandidates } from "./brief";

type StarterPhoto = Pick<OnboardingCandidates["drafts"][number], "mediaIds" | "mediaPreview">;

/** Imports one actual image from an owned Instagram post using the shared import caps. */
export async function prepareOnboardingInstagramPhoto(
  workspaceId: string,
  postId: string,
): Promise<StarterPhoto | null> {
  const { data, error } = await db.rpc("claim_onboarding_instagram_photo", {
    p_user_id: workspaceId,
    p_post_id: postId,
  });
  if (error || !data?.[0]) return null;
  const claim = data[0] as { id: string; user_id: string; lease_id: string | null };
  if (claim.user_id !== workspaceId) throw new Error("The photo belongs to another workspace.");
  if (claim.lease_id)
    await processContentMediaImportMessage({
      kind: "content_media_import",
      id: claim.id,
      userId: workspaceId,
      leaseId: claim.lease_id,
    });
  const { data: row, error: mediaError } = await db
    .from("creator_content_media")
    .select("id,source_url")
    .eq("id", claim.id)
    .eq("user_id", workspaceId)
    .eq("provider", "instagram")
    .eq("media_type", "image")
    .eq("status", "ready")
    .maybeSingle();
  if (mediaError || !row) return null;
  const [asset] = await resolveOwnedAgentMedia(workspaceId, [claim.id]);
  if (!asset || !/^image\/(jpeg|png|webp)$/.test(asset.mimeType) || asset.size > 8 * 1024 * 1024)
    return null;
  return {
    mediaIds: [claim.id],
    mediaPreview: {
      mediaId: claim.id,
      url: asset.url,
      alt: "Your photo from the connected Instagram post",
      sourceUrl:
        typeof row.source_url === "string" &&
        parsePublicHttpUrl(row.source_url, { requireHttps: true })
          ? row.source_url
          : null,
    },
  };
}

export async function validateOnboardingDraftMedia(
  workspaceId: string,
  candidates: OnboardingCandidates,
) {
  for (const draft of candidates.drafts) {
    if (!draft.mediaIds?.length) continue;
    if (draft.platform !== "linkedin")
      throw new Error("This starter photo belongs on the LinkedIn draft.");
    const [asset] = await resolveOwnedAgentMedia(workspaceId, draft.mediaIds);
    if (
      !asset ||
      draft.mediaPreview?.mediaId !== draft.mediaIds[0] ||
      draft.mediaPreview?.url !== asset.url
    )
      throw new Error("The reviewed photo changed. Prepare this draft again before continuing.");
  }
}

/** Add only the reviewed media to an untouched starter card after verified activation. */
export async function carryOnboardingDraftMedia(workspaceId: string, revision: number) {
  const { data, error } = await db.rpc("attach_onboarding_instagram_photo", {
    p_workspace_id: workspaceId,
    p_revision: revision,
  });
  if (error)
    throw new Error(
      "Your workspace is active, but its reviewed photo could not be attached. Retry activation.",
    );
  if (!data?.length) return;
  const { prepareAgentMessage } = await import("../content-agent-preparation.server");
  for (const card of data as Array<{ message_id: string; card_id: string }>)
    await prepareAgentMessage(workspaceId, card.message_id, card.card_id);
}
