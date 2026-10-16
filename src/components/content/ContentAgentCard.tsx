import { ContentDraftPreview } from "./ContentDraftPreview";
import type { SchedulerConnection } from "@/lib/social-scheduler";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ContentMediaAsset } from "@/lib/content-media";
import type { ContentAgentCard as Card } from "@/lib/content-agent";
import { ContentMarkdown } from "./ContentDocument";
import { ContentDraftImages } from "./ContentDraftImages";
import { ContentCarouselDraft } from "./ContentCarouselDraft";
import { carouselReady, type AgentDraftState, type AgentDraftEdit } from "@/lib/content-carousel";
import { prepareContentAgentDraft, handoffAgentDraft } from "@/lib/content-agent.functions";
import { micro } from "@/lib/micro-app-ui";

function isSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function ContentAgentCard({
  messageId,
  card,
  allCards,
  mediaAssets = [],
  previewAccounts = [],
  onApproveBrain,
  onRejectDraft,
  onRegenerateDraft,
  onApproveSchedule,
  onSaveDraft,
  draftState,
  onDraftChanged,
}: {
  messageId: string;
  card: Card;
  allCards: Card[];
  mediaAssets?: ContentMediaAsset[];
  previewAccounts?: SchedulerConnection[];
  onApproveBrain: (cardId: string) => void | Promise<void>;
  onRejectDraft: (cardId: string, reason: string) => void | Promise<void>;
  onRegenerateDraft: (cardId: string, reason: string) => void | Promise<void>;
  onApproveSchedule: (draftCardId: string, scheduleCardId: string) => void | Promise<void>;
  onSaveDraft?: (cardId: string, edit: AgentDraftEdit) => void | Promise<void>;
  draftState?: AgentDraftState;
  onDraftChanged?: () => void | Promise<unknown>;
}) {
  const [schedulePending, setSchedulePending] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  if (card.type === "source") {
    return (
      <article className="py-4">
        <p className={micro.eyebrowMuted}>{card.sourceName}</p>
        <h4 className="mt-1 font-semibold text-[#17213a]">{card.title}</h4>
        <p className={`mt-2 ${micro.mutedXs}`}>{card.summary}</p>
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#3478f6]"
        >
          Open source <ExternalLink className="size-3" />
        </a>
      </article>
    );
  }

  if (card.type === "idea") {
    return (
      <article className="py-4">
        <p className={micro.eyebrowMuted}>{card.format}</p>
        <h4 className="mt-1 font-semibold text-[#17213a]">{card.title}</h4>
        <ContentMarkdown text={card.premise} />
        <p className={`mt-2 ${micro.mutedXs}`}>Takeaway: {card.takeaway}</p>
      </article>
    );
  }

  if (card.type === "draft") {
    const proposal = allCards.find(
      (item) => item.type === "schedule_proposal" && item.draftCardId === card.cardId,
    );
    const destination = proposal?.type === "schedule_proposal" ? proposal.connectionId : null;
    return (
      <DraftCard
        card={card}
        previewAccount={
          previewAccounts.find((account) => account.id === destination) ||
          previewAccounts.find((account) => account.provider === card.platform)
        }
        onSchedule={proposal ? () => onApproveSchedule(card.cardId, proposal.cardId) : undefined}
        messageId={messageId}
        draftState={draftState}
        onDraftChanged={onDraftChanged}
        mediaAssets={mediaAssets}
        onSave={onSaveDraft ? (edit) => onSaveDraft(card.cardId, edit) : undefined}
        onReject={(reason) => onRejectDraft(card.cardId, reason)}
        onRegenerate={(reason) => onRegenerateDraft(card.cardId, reason)}
      />
    );
  }

  if (card.type === "brain_proposal") {
    return (
      <article className="py-4">
        <p className={micro.eyebrowMuted}>Brain proposal · {card.kind}</p>
        <h4 className="mt-1 font-semibold text-[#17213a]">{card.title}</h4>
        <ContentMarkdown text={card.content} />
        <button
          type="button"
          onClick={() => void onApproveBrain(card.cardId)}
          className="content-action content-action-primary mt-4"
        >
          Review and save to Brain
        </button>
      </article>
    );
  }

  if (card.type === "weekly_plan") {
    return (
      <article className="overflow-x-auto py-4">
        <p className={micro.eyebrowMuted}>Weekly plan</p>
        <table className="mt-3 w-full min-w-[30rem] text-left text-sm">
          <thead className="text-[#17213a]/45">
            <tr>
              <th className="pb-2 font-medium">Date</th>
              <th className="pb-2 font-medium">Platform</th>
              <th className="pb-2 font-medium">Idea</th>
            </tr>
          </thead>
          <tbody>
            {card.days.map((day) => (
              <tr key={`${day.date}:${day.platform}`} className="border-t border-black/[0.06]">
                <td className="py-2">{day.date}</td>
                <td className="py-2 capitalize">{day.platform}</td>
                <td className="py-2">{day.idea}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    );
  }

  const draft = allCards.find(
    (candidate) => candidate.type === "draft" && candidate.cardId === card.draftCardId,
  );
  return (
    <article className="py-4">
      <p className={micro.eyebrowMuted}>Schedule proposal</p>
      <p className="mt-2 text-sm text-[#17213a]">
        {new Date(card.scheduledAt).toLocaleString()} · {card.timezone}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Review and schedule</summary>
        <p className="my-3 text-xs text-neutral-500">
          Review this exact draft before adding it to your posting schedule.
        </p>
        <ContentMarkdown
          text={draft?.type === "draft" ? draft.body : "The linked draft is unavailable."}
        />
        <button
          type="button"
          disabled={
            !draft ||
            schedulePending ||
            (draft.type === "draft" &&
              draft.platform === "instagram" &&
              !carouselReady(draft.slides || [], draftState))
          }
          className="content-action content-action-primary mt-3"
          onClick={async () => {
            setSchedulePending(true);
            setScheduleError("");
            try {
              await onApproveSchedule(card.draftCardId, card.cardId);
            } catch (error) {
              setScheduleError(
                error instanceof Error ? error.message : "Could not schedule this draft.",
              );
            } finally {
              setSchedulePending(false);
            }
          }}
        >
          {schedulePending ? "Scheduling…" : "Approve schedule"}
        </button>
      </details>
      {scheduleError && (
        <p role="alert" className="text-xs text-red-700">
          {scheduleError}
        </p>
      )}
      <span className="sr-only">Message {messageId}</span>
    </article>
  );
}

function DraftCard({
  card,
  previewAccount,
  onSchedule,
  messageId,
  draftState,
  onDraftChanged,
  onReject,
  onRegenerate,
  onSave,
  mediaAssets,
}: {
  card: Extract<Card, { type: "draft" }>;
  previewAccount?: SchedulerConnection;
  onSchedule?: () => void | Promise<void>;
  messageId: string;
  draftState?: AgentDraftState;
  onDraftChanged?: () => void | Promise<unknown>;
  onReject: (reason: string) => void | Promise<void>;
  onRegenerate: (reason: string) => void | Promise<void>;
  onSave?: (edit: AgentDraftEdit) => void | Promise<void>;
  mediaAssets: ContentMediaAsset[];
}) {
  const [backgrounds, setBackgrounds] = useState<Record<string, string>>({});
  const [body, setBody] = useState(card.body);
  const [slides, setSlides] = useState(card.slides || []);
  const [editRevision, setEditRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);
  const revision = draftState?.revision || 0;
  const carousel = card.platform === "instagram" && card.format === "carousel";
  const imageControlsSupported =
    ["twitter", "linkedin", "instagram"].includes(card.platform) &&
    ["post", "carousel"].includes(card.format);
  const photoRequired = card.platform === "linkedin" || draftState?.photoRequired;
  const hasPhoto = (draftState?.mediaIds?.length || card.mediaIds?.length || 0) > 0;
  const ready =
    (carousel ? carouselReady(card.slides || [], draftState) : !photoRequired || hasPhoto) &&
    draftState?.preparation !== "visuals_needed";
  async function run(action: string, work: () => void | Promise<unknown>) {
    if (pending) return;
    setPending(action);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed. Please retry.");
    } finally {
      setPending("");
    }
  }
  return (
    <article className="min-w-0 py-4">
      <p className={micro.eyebrowMuted}>
        {card.platform} · {card.format}
      </p>
      {card.title && <h4 className="mt-1 font-semibold text-[#17213a]">{card.title}</h4>}
      {(carousel || photoRequired) && (
        <p className="mt-2 text-xs font-medium" role="status">
          {ready
            ? "Images attached · ready for review"
            : draftState?.preparationNote ||
              (carousel ? "Preparing carousel slides" : "Add a photo to finish this draft")}
        </p>
      )}
      {editing ? (
        <textarea
          aria-label="Edit draft"
          value={body}
          maxLength={10000}
          onChange={(e) => setBody(e.target.value)}
          className="content-document-input mt-3"
        />
      ) : !["post", "carousel"].includes(card.format) ? (
        <ContentMarkdown text={card.body} />
      ) : (
        <ContentDraftPreview
          platform={card.platform}
          body={card.body}
          title={card.title}
          assets={Object.fromEntries(
            (draftState?.mediaIds || card.mediaIds || [])
              .filter((id) => backgrounds[id])
              .map((id) => [id, backgrounds[id]]),
          )}
          connection={previewAccount}
        />
      )}
      {carousel && (
        <ContentCarouselDraft
          slides={editing ? slides : card.slides || []}
          editing={editing}
          backgrounds={backgrounds}
          onChange={setSlides}
          branding={draftState?.branding}
          renderedUrls={
            !editing && ready
              ? (draftState?.mediaIds || []).map((id) => backgrounds[id]).filter(Boolean)
              : undefined
          }
          disabled={Boolean(pending)}
        />
      )}
      {!editing && imageControlsSupported && (
        <ContentDraftImages
          draftRef={{ messageId, cardId: card.cardId, revision }}
          slideCount={carousel ? card.slides?.length || 0 : 0}
          showPreview={false}
          onChanged={onDraftChanged}
          onAssets={setBackgrounds}
        />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <>
            <button
              type="button"
              className="content-action"
              disabled={Boolean(pending) || !body.trim() || !onSave}
              onClick={() =>
                void run("save", async () => {
                  await onSave?.({
                    body: body.trim(),
                    revision: editRevision,
                    ...(carousel ? { slides } : {}),
                  });
                  setEditing(false);
                })
              }
            >
              {pending === "save" ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="content-action"
              disabled={Boolean(pending)}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="content-action"
              disabled={Boolean(pending)}
              onClick={() => {
                setBody(card.body);
                setSlides(card.slides || []);
                setEditRevision(revision);
                setEditing(true);
                setError("");
              }}
            >
              Edit draft
            </button>
            <button
              type="button"
              className="content-action"
              disabled={Boolean(pending)}
              onClick={() =>
                void run("copy", async () => {
                  await navigator.clipboard.writeText(card.body);
                  setCopied(true);
                })
              }
            >
              {copied ? "Copied" : "Copy"}
            </button>
            {!ready && imageControlsSupported && (
              <button
                type="button"
                className="content-action"
                disabled={Boolean(pending)}
                onClick={() =>
                  void run("prepare", async () => {
                    await prepareContentAgentDraft({ data: { messageId, cardId: card.cardId } });
                    await onDraftChanged?.();
                  })
                }
              >
                {pending === "prepare" ? "Preparing visuals…" : "Prepare visuals"}
              </button>
            )}
            {onSchedule && (
              <button
                type="button"
                className="content-action content-action-primary"
                disabled={!ready || Boolean(pending)}
                title="Approve this draft and add it to the proposed schedule"
                data-hover-guide="Approve this draft and add it to the proposed schedule"
                onClick={() =>
                  void run("schedule", async () => {
                    await onSchedule();
                    await onDraftChanged?.();
                  })
                }
              >
                {pending === "schedule" ? "Scheduling…" : "Approve & schedule"}
              </button>
            )}
            {["post", "carousel"].includes(card.format) && (
              <button
                type="button"
                className="content-action content-action-primary"
                disabled={(carousel && !ready) || Boolean(pending)}
                onClick={() =>
                  void run("handoff", async () => {
                    const saved = await handoffAgentDraft({
                      data: { messageId, cardId: card.cardId, revision },
                    });
                    if (!saved.socialPostId) throw new Error("Draft could not be opened.");
                    window.location.assign(
                      `/post-scheduler?postId=${encodeURIComponent(saved.socialPostId)}`,
                    );
                  })
                }
              >
                {pending === "handoff"
                  ? "Opening…"
                  : photoRequired && !hasPhoto
                    ? "Add photo in scheduler"
                    : "Open in scheduler"}
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
      {!imageControlsSupported &&
        (card.mediaIds || []).map((id) => {
          const asset = mediaAssets.find((m) => m.id === id);
          // Historical script/thread formats do not mount the owned-image loader.
          const ownedUrl =
            backgrounds[id] ||
            (!imageControlsSupported && asset?.type === "image" ? asset.url : undefined);
          return asset?.type === "video" || ownedUrl ? (
            <figure key={id} className="my-4">
              {asset?.type === "video" ? (
                <video
                  src={asset.url}
                  controls
                  className="max-h-80 rounded-lg"
                  aria-label={asset.title}
                />
              ) : (
                <img
                  src={ownedUrl}
                  alt={asset?.title || "Currently attached draft image"}
                  className="max-h-80 rounded-lg object-contain"
                />
              )}
              <figcaption className="mt-1 text-xs text-neutral-500">
                {asset?.type === "video"
                  ? asset.title
                  : `Currently attached image${asset?.title ? ` · ${asset.title}` : ""}`}
              </figcaption>
            </figure>
          ) : null;
        })}
      <p className={`mt-2 ${micro.mutedXs}`}>{card.rationale}</p>
      {card.sourceUrls.some(isSafeSourceUrl) && (
        <ul aria-label="Draft sources" className={`mt-2 space-y-1 ${micro.mutedXs}`}>
          {card.sourceUrls.filter(isSafeSourceUrl).map((url) => (
            <li key={url}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all underline"
              >
                {url}
              </a>
            </li>
          ))}
        </ul>
      )}
      {card.visualBrief && <p className={`mt-2 ${micro.mutedXs}`}>Visual: {card.visualBrief}</p>}
      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-medium">Improve this draft</summary>
        <label className="mt-3 grid gap-1 text-xs font-medium">
          Draft feedback
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value.slice(0, 1000))}
            className="content-field"
            placeholder="What should change?"
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="content-action"
            disabled={!feedback.trim() || Boolean(pending) || editing}
            onClick={() => void run("regenerate", () => onRegenerate(feedback.trim()))}
          >
            {pending === "regenerate" ? "Regenerating…" : "Regenerate draft"}
          </button>
          <button
            type="button"
            className="content-action"
            disabled={!feedback.trim() || Boolean(pending) || editing}
            onClick={() => void run("reject", () => onReject(feedback.trim()))}
          >
            {pending === "reject" ? "Rejecting…" : "Reject draft"}
          </button>
        </div>
      </details>
    </article>
  );
}
