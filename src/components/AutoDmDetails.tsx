import type { InstagramDmAutomation } from "@/lib/instagram-auto-dm";
import type { TwitterDmAutomation, TwitterDmActivity } from "@/lib/twitter-auto-dm";
import type { InstagramDmActivity } from "@/lib/instagram-auto-dm";

type Automation = TwitterDmAutomation &
  Partial<Omit<InstagramDmAutomation, keyof TwitterDmAutomation>>;
type FlowAutomation = Omit<Automation, "triggerType"> & { triggerType: string };

export function AutoDmMetrics({ automation }: { automation: FlowAutomation }) {
  const metrics = automation.metrics;
  const rows = [
    ["Matched events", metrics?.matched],
    ["Sent events", metrics?.sent],
    ["Failed events", metrics?.failed],
    ["Workflow runs", metrics?.runs],
    ["Completed workflows", metrics?.completed],
    ["Confirmations", metrics?.confirmations],
    ["Emails captured", metrics?.emails],
    ["Verified followers", metrics?.follows],
  ] as const;
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <dl className="grid gap-y-2 text-sm">
        {rows
          .filter(([, value]) => value !== null)
          .map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-semibold tabular-nums">
                {value == null ? "Unavailable" : value.toLocaleString()}
              </dd>
            </div>
          ))}
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="rounded-md bg-primary/10 px-2 py-1 font-semibold">
            {!automation.enabled
              ? "Paused"
              : automation.connectionReady
                ? "Enabled"
                : "Needs attention"}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Lifetime totals. Sent events can include opening messages; completed workflows count final
        delivery. Confirmations include button taps or typed replies. Outbound link clicks and newly
        gained followers are not tracked.
      </p>
    </div>
  );
}

export function AutoDmFlow({ automation: a }: { automation: FlowAutomation }) {
  return (
    <ol className="mt-4 space-y-3 border-l-2 border-primary/20 pl-4 text-sm leading-6">
      <li>
        <strong>1. Trigger · {a.triggerType.replaceAll("_", " ")}</strong>
        <p>Account: @{a.connectionHandle}</p>
        <p>
          Matching: {a.matchType}. Keywords: {a.keywords.join(", ") || "Any eligible event"}.
        </p>
        {a.excludedKeywords.length > 0 && <p>Excluded: {a.excludedKeywords.join(", ")}</p>}
        {a.mediaScope && (
          <p>
            Posts: {a.mediaScope}
            {a.mediaIds?.length ? ` · ${a.mediaIds.join(", ")}` : ""}
          </p>
        )}
      </li>
      {a.publicReplyEnabled && (
        <li>
          <strong>Public reply</strong>
          {a.publicReplyMessages?.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </li>
      )}
      {a.openingMessage && (
        <li>
          <strong>Opening message → confirmation</strong>
          <p className="whitespace-pre-wrap">{a.openingMessage}</p>
          <p>Action: {a.confirmationButtonLabel}</p>
        </li>
      )}
      {a.followGateEnabled && (
        <li>
          <strong>Follow check</strong>
          <p>{a.followPromptMessage}</p>
          <p>
            Up to {a.followMaxRechecks} rechecks; then{" "}
            {a.followFailAction === "withhold" ? "withhold delivery" : "send anyway"}.
          </p>
        </li>
      )}
      {a.emailCaptureEnabled && (
        <li>
          <strong>Email capture</strong>
          <p>{a.emailPromptMessage}</p>
          <p>Marketing consent: {a.emailMarketingConsentEnabled ? "Requested" : "Not requested"}</p>
        </li>
      )}
      <li>
        <strong>Final message</strong>
        <p className="whitespace-pre-wrap">{a.replyMessage}</p>
        {a.replyButtonLabel && (
          <p>
            Button: {a.replyButtonLabel} · {a.replyButtonUrl}
          </p>
        )}
      </li>
      <li>
        <strong>{a.enabled ? "Enabled" : "Paused"}</strong>
        {a.connectionReadinessMessage && <p>{a.connectionReadinessMessage}</p>}
      </li>
    </ol>
  );
}

export function AutoDmActivityRow({
  event,
  automation,
}: {
  event: InstagramDmActivity | TwitterDmActivity;
  automation?: FlowAutomation;
}) {
  return (
    <details className="border-b border-border/60 py-3 last:border-0">
      <summary className="cursor-pointer rounded-lg p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="font-semibold">{event.senderLabel}</span>
        <span className="ml-3 rounded-md bg-muted px-2 py-1 text-xs capitalize">
          {event.status}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {event.automationName || "No matching automation"} ·{" "}
          <time dateTime={event.createdAt} suppressHydrationWarning>
            {new Date(event.createdAt).toLocaleString()}
          </time>
        </span>
      </summary>
      <dl className="grid gap-2 px-2 py-3 text-sm">
        <div>
          <dt className="font-semibold">Event</dt>
          <dd>{"eventContext" in event ? event.eventContext : event.eventType}</dd>
        </div>
        <div>
          <dt className="font-semibold">Matched keyword</dt>
          <dd>{event.matchedKeyword || "None"}</dd>
        </div>
        {event.errorMessage && (
          <div>
            <dt className="font-semibold">Delivery error</dt>
            <dd className="break-words text-rose-700">{event.errorMessage}</dd>
          </div>
        )}
        <div>
          <dt className="font-semibold">Event ID</dt>
          <dd className="break-all">{event.id}</dd>
        </div>
      </dl>
      {automation ? (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-semibold">
            View automation: {automation.name}
          </summary>
          <AutoDmFlow automation={automation} />
        </details>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">
          {event.automationName
            ? "This automation is no longer available."
            : "This event did not match an automation."}
        </p>
      )}
    </details>
  );
}
