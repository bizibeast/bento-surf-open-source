import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ContentMediaAsset } from "@/lib/content-media";
import type { ContentAgentCard as Card } from "@/lib/content-agent";
import { ContentMarkdown } from "./ContentDocument";
import { micro } from "@/lib/micro-app-ui";

export function ContentAgentCard({
  messageId,
  card,
  allCards,
  mediaAssets = [],
  onApproveBrain,
  onRejectDraft,
  onRegenerateDraft,
  onApproveSchedule,
  onSaveDraft,
}: {
  messageId: string;
  card: Card;
  allCards: Card[];
  mediaAssets?: ContentMediaAsset[];
  onApproveBrain: (cardId: string) => void | Promise<void>;
  onRejectDraft: (cardId: string, reason: string) => void | Promise<void>;
  onRegenerateDraft: (cardId: string, reason: string) => void | Promise<void>;
  onApproveSchedule: (draftCardId: string, scheduleCardId: string) => void | Promise<void>;
  onSaveDraft?: (cardId: string, body: string) => void | Promise<void>;
}) {
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
    return (
      <DraftCard
        card={card}
        mediaAssets={mediaAssets}
        onSave={onSaveDraft ? (body) => onSaveDraft(card.cardId, body) : undefined}
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
          disabled={!draft}
          className="content-action content-action-primary mt-3"
          onClick={() => void onApproveSchedule(card.draftCardId, card.cardId)}
        >
          Approve schedule
        </button>
      </details>
      <span className="sr-only">Message {messageId}</span>
    </article>
  );
}

function DraftCard({
  card,
  onReject,
  onRegenerate,
  onSave,
  mediaAssets,
}: {
  card: Extract<Card, { type: "draft" }>;
  onReject: (reason: string) => void | Promise<void>;
  onRegenerate: (reason: string) => void | Promise<void>;
  onSave?: (body: string) => void | Promise<void>;
  mediaAssets: ContentMediaAsset[];
}) {
  const [body, setBody] = useState(card.body);
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <article className="py-4">
      <p className={micro.eyebrowMuted}>
        {card.platform} · {card.format}
      </p>
      {card.title && <h4 className="mt-1 font-semibold text-[#17213a]">{card.title}</h4>}
      {editing ? (
        <>
          <textarea
            aria-label="Edit draft"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={10_000}
            className="content-document-input mt-3"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!body.trim() || saving || !onSave}
              className="content-action"
              onClick={async () => {
                setSaving(true);
                setSaveError("");
                try {
                  await onSave?.(body.trim());
                  setEditing(false);
                } catch (error) {
                  setSaveError(error instanceof Error ? error.message : "Could not save draft.");
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="content-action"
              disabled={saving}
              onClick={() => {
                setBody(card.body);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
          {saveError && (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {saveError}
            </p>
          )}
        </>
      ) : (
        <>
          <ContentMarkdown text={card.body} />
          <button type="button" className="content-action" onClick={() => setEditing(true)}>
            Edit draft
          </button>
        </>
      )}
      {(card.mediaIds || []).map((id) => {
        const asset = mediaAssets.find((media) => media.id === id);
        return asset ? (
          <figure key={id} className="my-4">
            {asset.type === "video" ? (
              <video
                src={asset.url}
                controls
                className="max-h-80 rounded-lg"
                aria-label={asset.title}
              />
            ) : (
              <img
                src={asset.url}
                alt={asset.title}
                className="max-h-80 rounded-lg object-contain"
              />
            )}
            <figcaption className="mt-1 text-xs text-neutral-500">{asset.title}</figcaption>
          </figure>
        ) : null;
      })}
      <p className={`mt-2 ${micro.mutedXs}`}>{card.rationale}</p>
      {card.visualBrief && <p className={`mt-2 ${micro.mutedXs}`}>Visual: {card.visualBrief}</p>}
      <label className="mt-4 grid gap-1 text-xs font-medium text-[#17213a]/60">
        Draft feedback
        <input
          value={feedback}
          onChange={(event) => setFeedback(event.target.value.slice(0, 1_000))}
          className="content-field"
          placeholder="What should change?"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!feedback.trim()}
          onClick={() => void onRegenerate(feedback.trim())}
          className="content-action"
        >
          Regenerate draft
        </button>
        <button
          type="button"
          disabled={!feedback.trim()}
          onClick={() => void onReject(feedback.trim())}
          className="content-action"
        >
          Reject draft
        </button>
      </div>
    </article>
  );
}
