import { xCommunityFromSettings } from "@/lib/x-community";
import { useId, useState, type ReactNode } from "react";
import { Check, Clock3, LoaderCircle } from "lucide-react";
import { FaLinkedinIn } from "react-icons/fa";
import {
  SiFacebook,
  SiInstagram,
  SiReddit,
  SiThreads,
  SiTiktok,
  SiX,
  SiYoutube,
} from "react-icons/si";
import { ProviderPostPreview } from "@/components/scheduler/ProviderPostPreview";
import {
  SOCIAL_PROVIDER_DEFINITIONS,
  schedulerMediaSchema,
  type SchedulerConnection,
  type SchedulerMedia,
} from "@/lib/social-scheduler";
import { isoToZonedDateTimeInput, zonedDateTimeInputToIso } from "@/lib/local-datetime";
import type {
  AgentAppAction,
  AgentAppActionState,
  AgentPostEdit,
} from "@/lib/content-agent-app-actions";

const icons = {
  instagram: SiInstagram,
  linkedin: FaLinkedinIn,
  twitter: SiX,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  youtube: SiYoutube,
  reddit: SiReddit,
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const mediaItem = (value: unknown): SchedulerMedia | null => {
  const result = schedulerMediaSchema.safeParse(value);
  return result.success ? result.data : null;
};

export function agentPostCaption(post: Record<string, unknown>, connection: SchedulerConnection) {
  const settings = record(record(post.providerSettings)[connection.provider]);
  const override = record(record(post.connectionOverrides)[connection.id]);
  return String(override.bodyOverride ?? settings.bodyOverride ?? post.body ?? "");
}

/** The landing demo and authenticated Agent render this exact review surface. */
export function AgentPostReview({
  post,
  accounts,
  stockPhoto,
  status = "pending",
  busy = false,
  disabled = false,
  error,
  onApprove,
  onEdit,
  children,
  demo = false,
}: {
  post: Record<string, unknown>;
  accounts: SchedulerConnection[];
  stockPhoto?: AgentAppAction["stockPhoto"];
  status?: AgentAppActionState["status"];
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  onApprove?: () => void;
  onEdit?: (edit: AgentPostEdit) => Promise<unknown>;
  children?: ReactNode;
  demo?: boolean;
}) {
  const connections = accounts.filter(
    (a) => Array.isArray(post.connectionIds) && post.connectionIds.includes(a.id),
  );
  const [selected, setSelected] = useState(connections[0]?.id);
  const connection = connections.find((a) => a.id === selected) || connections[0];
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const inputId = useId();
  const timezone = String(post.timezone || "UTC");
  const media = (Array.isArray(post.media) ? post.media : []).flatMap((item) => {
    const m = mediaItem(item);
    return m ? [m] : [];
  });
  if (!media.length && stockPhoto)
    media.push({
      key: `stock-preview:${stockPhoto.provider}:${stockPhoto.id}`,
      url: stockPhoto.previewUrl,
      name: stockPhoto.description,
      mimeType: "image/jpeg",
      size: 1,
    });
  const settings = {
    ...record(record(post.providerSettings)[connection?.provider || ""]),
    ...record(record(post.connectionOverrides)[connection?.id || ""]),
  };
  let when = "";
  if (typeof post.scheduledAt === "string" && Number.isFinite(Date.parse(post.scheduledAt))) {
    try {
      when =
        new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: timezone,
        }).format(new Date(post.scheduledAt)) + ` · ${timezone}`;
    } catch {
      when = post.scheduledAt;
    }
  }
  const pending = status === "pending";
  const missingAccounts =
    Array.isArray(post.connectionIds) && connections.length !== new Set(post.connectionIds).size;
  const blocked =
    post.mode !== "draft" &&
    connections.find((a) => a.canPublish === false || a.status !== "active");
  const blocker = missingAccounts
    ? "A selected account is no longer connected. Ask the Agent to update the destinations."
    : blocked
      ? blocked.publishBlockReason ||
        `Reconnect ${SOCIAL_PROVIDER_DEFINITIONS[blocked.provider].name} before scheduling.`
      : "";
  const statusText =
    status === "completed"
      ? demo
        ? "Approved in demo"
        : post.mode === "schedule"
          ? "Scheduled"
          : post.mode === "publish_now"
            ? "Queued for publishing"
            : "Draft saved"
      : status === "running"
        ? "Processing"
        : status === "failed"
          ? "Needs attention"
          : status === "dismissed"
            ? "Dismissed"
            : "Ready for your review";
  const approveText =
    post.mode === "schedule"
      ? "Approve & schedule"
      : post.mode === "publish_now"
        ? "Approve & publish"
        : "Save draft";
  return (
    <section aria-label="Post review" className="min-w-0 space-y-3" data-agent-post-review>
      <ul
        aria-label="Prepared post details"
        className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground"
      >
        {[
          connections.length
            ? `${connections.length} ${connections.length === 1 ? "destination" : "destinations"}`
            : null,
          media.length
            ? stockPhoto
              ? "Stock photo selected"
              : `${media.length} ${media.length === 1 ? "visual" : "visuals"} attached`
            : null,
          when ? "Time selected" : null,
        ]
          .filter(Boolean)
          .map((task) => (
            <li
              key={task}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"
            >
              <Check className="size-3 text-emerald-600" aria-hidden="true" />
              {task}
            </li>
          ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          role="status"
          className={`text-xs font-semibold ${status === "completed" ? "text-emerald-700" : "text-[#245fd0]"}`}
        >
          {statusText}
        </p>
        <div className="flex flex-wrap gap-1" aria-label="Post destinations">
          {connections.map((a) => {
            const Icon = icons[a.provider];
            const name = `${SOCIAL_PROVIDER_DEFINITIONS[a.provider].name}: ${a.displayName || a.handle}`;
            return (
              <button
                key={a.id}
                type="button"
                aria-label={`Preview ${name}`}
                title={`Preview ${name}`}
                aria-pressed={connection?.id === a.id}
                disabled={editing}
                onClick={() => setSelected(a.id)}
                className="grid size-10 place-items-center rounded-full border border-transparent bg-muted transition hover:bg-muted/70 aria-pressed:border-[#8eafea] aria-pressed:bg-[#e9f1ff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#3478f6]"
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      {connection && (
        <p className="text-xs text-muted-foreground">
          {SOCIAL_PROVIDER_DEFINITIONS[connection.provider].name} ·{" "}
          {connection.displayName || connection.handle}
        </p>
      )}
      {editing && connection ? (
        <form
          className="space-y-3 rounded-xl border border-[#c5d8fb] bg-muted/30 p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setEditError("");
            const scheduledAt =
              post.mode === "schedule" ? zonedDateTimeInputToIso(time, timezone) : undefined;
            if (
              post.mode === "schedule" &&
              (!scheduledAt || (!demo && Date.parse(scheduledAt) <= Date.now()))
            ) {
              setEditError("Choose a valid future time in the displayed timezone.");
              return;
            }
            setSaving(true);
            try {
              await onEdit?.({
                connectionId: connection.id,
                body,
                ...(scheduledAt ? { scheduledAt } : {}),
              });
              setEditing(false);
            } catch (e) {
              setEditError(e instanceof Error ? e.message : "Changes could not be saved.");
            } finally {
              setSaving(false);
            }
          }}
        >
          <label htmlFor={inputId} className="block text-sm font-medium">
            Edit {SOCIAL_PROVIDER_DEFINITIONS[connection.provider].name} caption
          </label>
          <textarea
            id={inputId}
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            maxLength={25000}
            className="w-full resize-y rounded-lg border border-border bg-background p-3 text-base leading-6 sm:text-sm"
          />
          {post.mode === "schedule" && (
            <label className="block text-xs font-medium">
              Schedule for all destinations ({timezone})
              <input
                type="datetime-local"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="mt-2 block w-full min-w-0 rounded-lg border border-border bg-background p-2 text-base"
              />
            </label>
          )}
          {editError && (
            <p role="alert" className="text-sm text-red-700">
              {editError}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => setEditing(false)}
              className="rounded-full px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !body.trim()}
              className="rounded-full bg-[#3478f6] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      ) : connection ? (
        <ProviderPostPreview
          connection={connection}
          body={agentPostCaption(post, connection)}
          title={String(settings.titleOverride || post.title || "")}
          media={media}
          youtubeThumbnail={mediaItem(settings.thumbnail)}
          youtubeFormat={
            settings.youtubeFormat === "short" || settings.youtubeFormat === "video"
              ? settings.youtubeFormat
              : null
          }
          instagramCover={mediaItem(settings.cover)}
          tiktokPrivacy={String(settings.privacyLevel || "SELF_ONLY")}
          youtubePrivacy={String(settings.youtubePrivacy || "private")}
          redditCommunity={String(settings.community || "")}
          redditKind={settings.kind === "link" ? "link" : "self"}
          redditUrl={String(settings.url || "")}
          xCommunity={xCommunityFromSettings(settings)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{String(post.body || "")}</p>
      )}
      {stockPhoto && (
        <p className="text-[11px] text-muted-foreground">
          Stock photo by{" "}
          <a href={stockPhoto.url} target="_blank" rel="noreferrer noopener" className="underline">
            {stockPhoto.photographer}
          </a>{" "}
          · {stockPhoto.provider}.{" "}
          {status === "completed" ? "Imported with this post." : "Imported when approved."}
        </p>
      )}
      {blocker && (
        <p role="status" className="text-xs text-muted-foreground">
          {blocker}
        </p>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
          {when ||
            (post.mode === "publish_now" ? "After your approval" : "Save without publishing")}
        </span>
        {pending && onEdit && (
          <button
            type="button"
            disabled={disabled || busy || editing || !connection}
            onClick={() => {
              if (!connection) return;
              setBody(agentPostCaption(post, connection));
              setTime(isoToZonedDateTimeInput(String(post.scheduledAt || ""), timezone));
              setEditError("");
              setEditing(true);
            }}
            title="Edit this caption and schedule before approving"
            className="rounded-full px-3 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Edit
          </button>
        )}
        {pending && onApprove && (
          <button
            type="button"
            disabled={disabled || busy || editing || !!blocker}
            title={blocker || "Approve these exact posts for all displayed destinations"}
            onClick={onApprove}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#3478f6] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2464da] disabled:opacity-40"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" />}
            {busy ? "Processing…" : approveText}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
