import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import {
  getContentAgentActionStates,
  reviewContentAgentAction,
} from "@/lib/content-agent.functions";
import type { AgentAppAction, AgentAppActionState } from "@/lib/content-agent-app-actions";
import { ProviderPostPreview } from "@/components/scheduler/ProviderPostPreview";
import {
  SOCIAL_PROVIDER_DEFINITIONS,
  schedulerMediaSchema,
  type SchedulerConnection,
  type SchedulerMedia,
} from "@/lib/social-scheduler";
import { micro } from "@/lib/micro-app-ui";

function label(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/\bDm\b/g, "DM");
}
function Details({ value, accounts }: { value: unknown; accounts: SchedulerConnection[] }) {
  if (value === null || value === undefined) return <span>None</span>;
  if (typeof value === "boolean") return <span>{value ? "On" : "Off"}</span>;
  if (Array.isArray(value))
    return (
      <div className="space-y-2">
        {value.length
          ? value.map((item, i) => (
              <div key={i}>
                <Details value={item} accounts={accounts} />
              </div>
            ))
          : "None"}
      </div>
    );
  if (typeof value === "object")
    return (
      <dl className="space-y-3">
        {Object.entries(value)
          .filter(([key]) => !["key", "size", "mimeType"].includes(key))
          .map(([key, item]) => (
            <div key={key}>
              <dt className="text-xs font-medium text-muted-foreground">{label(key)}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
                <Details value={item} accounts={accounts} />
              </dd>
            </div>
          ))}
      </dl>
    );
  const account = accounts.find((a) => a.id === value);
  return (
    <span>
      {account
        ? `${SOCIAL_PROVIDER_DEFINITIONS[account.provider].name}: ${account.displayName || account.handle}`
        : String(value)}
    </span>
  );
}
export function ContentAgentAppActions({
  messageId,
  actions,
  accounts,
}: {
  messageId: string;
  actions: AgentAppAction[];
  accounts: SchedulerConnection[];
}) {
  const client = useQueryClient();
  const key = ["content-agent-app-actions", messageId];
  const [pollStarted] = useState(Date.now);
  const status = useQuery({
    queryKey: key,
    queryFn: () => getContentAgentActionStates({ data: { messageId } }),
    staleTime: 30000,
    refetchInterval: (query) =>
      Date.now() - pollStarted < 180000 && query.state.data?.some((row) => row.status === "running")
        ? 10000
        : false,
  });
  const review = useMutation({
    mutationFn: ({ id, dismiss }: { id: string; dismiss: boolean }) =>
      reviewContentAgentAction({ data: { id, dismiss } }),
    onSuccess: async (result) => {
      client.setQueryData(key, (rows: AgentAppActionState[] | undefined) =>
        rows?.map((row) => (row.id === result.id ? { ...row, ...result } : row)),
      );
      await client.invalidateQueries({ queryKey: ["social-scheduler"] });
    },
  });
  return (
    <div className="space-y-4">
      {actions.map((action) => (
        <ActionReview
          key={action.id}
          action={action}
          accounts={accounts}
          state={status.data?.find((row) => row.id === action.id)}
          loading={status.isPending}
          unavailable={
            status.isError ||
            (status.isSuccess && !status.data?.some((row) => row.id === action.id))
          }
          busy={review.isPending && review.variables?.id === action.id}
          error={
            review.isError && review.variables?.id === action.id ? review.error.message : undefined
          }
          onReview={(dismiss) => review.mutate({ id: action.id, dismiss })}
          onRefresh={() => void status.refetch()}
        />
      ))}
    </div>
  );
}
function ActionReview({
  action,
  accounts,
  state,
  loading,
  unavailable,
  busy,
  error,
  onReview,
  onRefresh,
}: {
  action: AgentAppAction;
  accounts: SchedulerConnection[];
  state?: AgentAppActionState;
  loading: boolean;
  unavailable: boolean;
  busy: boolean;
  error?: string;
  onReview: (dismiss: boolean) => void;
  onRefresh: () => void;
}) {
  const args = action.arguments;
  const connections = Array.isArray(args.connectionIds)
    ? accounts.filter((a) => (args.connectionIds as string[]).includes(a.id))
    : [];
  const [previewId, setPreviewId] = useState(connections[0]?.id);
  const connection = connections.find((a) => a.id === previewId) || connections[0];
  const isPost = action.tool === "create_social_post";
  const media = (Array.isArray(args.media) ? args.media : []).flatMap((item) => {
    const parsed = schedulerMediaSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const providerSettings =
    args.providerSettings &&
    typeof args.providerSettings === "object" &&
    !Array.isArray(args.providerSettings)
      ? args.providerSettings
      : {};
  const settingsValue = connection ? providerSettings[connection.provider] : null;
  const settings =
    settingsValue && typeof settingsValue === "object" && !Array.isArray(settingsValue)
      ? settingsValue
      : {};
  const overrides =
    args.connectionOverrides &&
    typeof args.connectionOverrides === "object" &&
    !Array.isArray(args.connectionOverrides)
      ? args.connectionOverrides
      : {};
  const overrideValue = connection ? overrides[connection.id] : null;
  const override =
    overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue)
      ? overrideValue
      : {};
  const postBody = String(override.bodyOverride ?? settings.bodyOverride ?? args.body ?? "");
  const getMedia = (value: unknown): SchedulerMedia | null => {
    const result = schedulerMediaSchema.safeParse(value);
    return result.success ? result.data : null;
  };
  const pending = state?.status === "pending";
  const completed = state?.status === "completed";
  const heading = isPost
    ? args.mode === "schedule"
      ? "Schedule this post"
      : args.mode === "publish_now"
        ? "Publish this post"
        : "Save this draft"
    : action.title;
  const time = typeof args.scheduledAt === "string" ? new Date(args.scheduledAt) : null;
  let when = "";
  if (time && Number.isFinite(time.getTime())) {
    try {
      when =
        new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: String(args.timezone || "UTC"),
        }).format(time) + ` (${args.timezone || "UTC"})`;
    } catch {
      when = String(args.scheduledAt);
    }
  }
  return (
    <article
      className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5"
      aria-label={heading}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-base font-semibold">{heading}</h3>
        <span className="text-xs text-muted-foreground">
          {completed
            ? "Completed"
            : state?.status === "dismissed"
              ? "Dismissed"
              : state?.status === "running"
                ? "Processing"
                : state?.status === "failed"
                  ? "Needs attention"
                  : "Ready for review"}
        </span>
      </div>
      {isPost && (
        <>
          {when && <p className="mb-3 text-sm font-medium">{when}</p>}
          <div className="mb-3 flex flex-wrap gap-2" aria-label="Post destinations">
            {connections.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setPreviewId(a.id)}
                aria-pressed={connection?.id === a.id}
                title={`Preview ${SOCIAL_PROVIDER_DEFINITIONS[a.provider].name}: ${a.displayName || a.handle}`}
                className="rounded-full border border-border px-3 py-1.5 text-xs aria-pressed:bg-muted"
              >
                {SOCIAL_PROVIDER_DEFINITIONS[a.provider].name} · {a.displayName || a.handle}
              </button>
            ))}
          </div>
          {connection ? (
            <ProviderPostPreview
              connection={connection}
              body={postBody}
              title={String(settings.titleOverride || args.title || "")}
              media={media}
              youtubeThumbnail={getMedia(settings.thumbnail)}
              youtubeFormat={
                settings.youtubeFormat === "short" || settings.youtubeFormat === "video"
                  ? settings.youtubeFormat
                  : null
              }
              instagramCover={getMedia(settings.cover)}
              tiktokPrivacy={String(settings.privacyLevel || "SELF_ONLY")}
              youtubePrivacy={String(settings.youtubePrivacy || "private")}
              redditCommunity={String(settings.community || "")}
              redditKind={settings.kind === "link" ? "link" : "self"}
              redditUrl={String(settings.url || "")}
            />
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-7">
              {String(args.body || "")}
            </p>
          )}
        </>
      )}
      <details className="mt-4" open={!isPost}>
        <summary className="cursor-pointer text-sm font-medium">
          {isPost ? "Review all settings, media and Auto DMs" : "Review details"}
        </summary>
        <div className="mt-3 max-h-80 overflow-y-auto rounded-xl bg-muted/50 p-3">
          <Details value={args} accounts={accounts} />
        </div>
      </details>
      {(state?.message || error) && (
        <p
          role={error || state?.status === "failed" ? "alert" : "status"}
          className="mt-3 whitespace-pre-wrap break-words text-sm leading-6"
        >
          {error || state?.message}
        </p>
      )}
      {unavailable && (
        <p role="alert" className="mt-3 text-sm">
          This review could not be loaded. Refresh its status before approving.
        </p>
      )}
      {state?.status === "failed" && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Check the destination for any partial changes before asking the Agent to prepare a new
          action.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {pending && (
          <>
            <button
              type="button"
              className={micro.btnPrimary}
              disabled={busy || loading || unavailable}
              onClick={() => onReview(false)}
            >
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {args.mode === "publish_now"
                ? "Approve & publish"
                : args.mode === "schedule"
                  ? "Approve & schedule"
                  : "Approve action"}
            </button>
            <button
              type="button"
              className={micro.btnSoft}
              disabled={busy}
              onClick={() => onReview(true)}
            >
              Dismiss
            </button>
          </>
        )}
        {(unavailable || state?.status === "running") && (
          <button type="button" className={micro.btnSoft} onClick={onRefresh}>
            Refresh status
          </button>
        )}
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            Checking action status…
          </p>
        )}
      </div>
    </article>
  );
}
