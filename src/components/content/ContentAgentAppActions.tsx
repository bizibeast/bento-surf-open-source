import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { usePageActivity } from "@/hooks/use-page-activity";
import { pagePollInterval } from "@/lib/page-poll";
import { Check, LoaderCircle } from "lucide-react";
import {
  getContentAgentActionStates,
  reviewContentAgentAction,
  editContentAgentPostAction,
} from "@/lib/content-agent.functions";
import type { AgentAppAction, AgentAppActionState } from "@/lib/content-agent-app-actions";
import { AgentPostReview } from "./AgentPostReview";
import type { AgentPostEdit } from "@/lib/content-agent-app-actions";
import { SOCIAL_PROVIDER_DEFINITIONS, type SchedulerConnection } from "@/lib/social-scheduler";
import { micro } from "@/lib/micro-app-ui";

function label(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/\bDm\b/g, "DM");
}
function Details({
  value,
  accounts,
  labels = {},
}: {
  value: unknown;
  accounts: SchedulerConnection[];
  labels?: Record<string, string>;
}) {
  if (value === null || value === undefined) return <span>None</span>;
  if (typeof value === "boolean") return <span>{value ? "On" : "Off"}</span>;
  if (Array.isArray(value))
    return (
      <div className="space-y-2">
        {value.length
          ? value.map((item, i) => (
              <div key={i}>
                <Details value={item} accounts={accounts} labels={labels} />
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
                <Details value={item} accounts={accounts} labels={labels} />
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
        : labels[String(value)] || String(value)}
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
  const activity = usePageActivity();
  const key = ["content-agent-app-actions", messageId];
  const [pollStarted] = useState(Date.now);
  const status = useQuery({
    queryKey: key,
    queryFn: () => getContentAgentActionStates({ data: { messageId } }),
    staleTime: 30000,
    refetchInterval: (query) =>
      Date.now() - pollStarted < 180000 && query.state.data?.some((row) => row.status === "running")
        ? pagePollInterval(10_000, activity, { idleMs: 30_000 })
        : false,
    refetchIntervalInBackground: false,
  });
  const review = useMutation({
    onError: () => {
      void client.invalidateQueries({ queryKey: key });
    },
    mutationFn: ({ id, dismiss, revision }: { id: string; dismiss: boolean; revision?: string }) =>
      reviewContentAgentAction({ data: { id, dismiss, revision } }),
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
          onReview={(dismiss) =>
            review.mutate({
              id: action.id,
              dismiss,
              revision: status.data?.find((row) => row.id === action.id)?.revision,
            })
          }
          onEdit={async (edit) => {
            const revision = status.data?.find((row) => row.id === action.id)?.revision;
            if (!revision) throw new Error("Refresh this review before editing.");
            const updated = await editContentAgentPostAction({
              data: { id: action.id, revision, edit },
            });
            client.setQueryData(key, (rows: AgentAppActionState[] | undefined) =>
              rows?.map((row) => (row.id === updated.id ? updated : row)),
            );
          }}
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
  onEdit,
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
  onEdit: (edit: AgentPostEdit) => Promise<unknown>;
}) {
  const args = state?.arguments || action.arguments;
  const isPost = action.tool === "create_social_post";
  const pending = state?.status === "pending";
  const completed = state?.status === "completed";
  const heading = isPost
    ? args.mode === "schedule"
      ? "Schedule this post"
      : args.mode === "publish_now"
        ? "Publish this post"
        : "Save this draft"
    : action.title;
  return (
    <article
      className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5"
      aria-label={heading}
    >
      {isPost ? (
        <AgentPostReview
          post={args}
          accounts={accounts}
          stockPhoto={action.stockPhoto}
          status={state?.status || "running"}
          busy={busy}
          disabled={loading || unavailable || !state?.revision}
          onApprove={() => onReview(false)}
          onEdit={onEdit}
        />
      ) : (
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
      )}
      <details className="mt-4" open={!isPost}>
        <summary className="cursor-pointer text-sm font-medium">
          {isPost ? "Review all settings, media and Auto DMs" : "Review details"}
        </summary>
        <div className="mt-3 max-h-80 overflow-y-auto rounded-xl bg-muted/50 p-3">
          <Details value={args} accounts={accounts} labels={action.labels} />
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
            {!isPost && (
              <button
                type="button"
                className={micro.btnPrimary}
                disabled={busy || loading || unavailable || !state?.revision}
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
            )}
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
        {(unavailable || error || state?.status === "running") && (
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
