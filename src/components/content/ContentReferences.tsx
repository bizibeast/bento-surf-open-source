import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  getContentReference,
  getContentReferences,
  startContentReference,
} from "@/lib/content-reference.functions";
import { usePageActivity } from "@/hooks/use-page-activity";
import { pagePollInterval } from "@/lib/page-poll";

export function ContentReferences({
  initialId,
  onUse,
}: {
  initialId?: string;
  onUse: (prompt: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [sourceUrl, setSourceUrl] = useState("");
  const [gridOnly, setGridOnly] = useState(false);
  const client = useQueryClient();
  const [started, setStarted] = useState(Date.now);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const activity = usePageActivity();
  const poll = (pending: boolean) =>
    pending && Date.now() - started < 8 * 60_000
      ? pagePollInterval(5000, activity, { idleMs: 30_000 })
      : false;
  const pending = ({ status }: { status: string }) =>
    status === "queued" || status === "processing";
  const references = useQuery({
    queryKey: ["content-references"],
    queryFn: () => getContentReferences(),
    retry: false,
    refetchInterval: (query) => poll(!selectedId && !!query.state.data?.some(pending)),
    refetchIntervalInBackground: false,
  });
  const selected = useQuery({
    queryKey: ["content-references", selectedId],
    queryFn: () => getContentReference({ data: { id: selectedId! } }),
    enabled: !!selectedId,
    retry: false,
    refetchInterval: (query) => poll(!!query.state.data && pending(query.state.data)),
    refetchIntervalInBackground: false,
  });
  const current = selectedId
    ? selected.isSuccess
      ? selected.data
      : undefined
    : references.data?.[0];
  const listed = references.data || [];
  const choices = !current
    ? listed
    : listed.some(({ id }) => id === current.id)
      ? listed.map((row) => (row.id === current.id ? current : row))
      : [current, ...listed];
  const start = useMutation({
    mutationFn: () =>
      startContentReference({ data: { sourceUrl, requestId, gridOnly, rightsConfirmed: true } }),
    onSuccess: async (job) => {
      client.setQueryData(["content-references", job.id], job);
      setSelectedId(job.id);
      setSourceUrl("");
      setRequestId(crypto.randomUUID());
      setStarted(Date.now());
      await client.invalidateQueries({ queryKey: ["content-references"] });
    },
  });
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-muted-foreground">
        Ask Benny to study a public Reel or carousel, or make a frame grid from your video.
        References are private and expire after seven days.
      </p>
      <form
        className="space-y-3 rounded-xl border border-border p-4"
        data-reference-request-id={requestId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!start.isPending) start.mutate();
        }}
      >
        <label className="block text-sm font-medium">
          Public Instagram reference
          <input
            type="url"
            required
            maxLength={2000}
            value={sourceUrl}
            onChange={(event) => {
              setSourceUrl(event.target.value);
              setRequestId(crypto.randomUUID());
            }}
            placeholder="https://www.instagram.com/reel/…"
            className="mt-2 block w-full rounded-lg border border-border bg-background p-2 font-normal"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={gridOnly}
            onChange={(event) => {
              setGridOnly(event.target.checked);
              setRequestId(crypto.randomUUID());
            }}
          />
          Every-frame grid only
        </label>
        <p className="text-xs text-muted-foreground">
          Use references you own or have permission to study. Video analysis requires Creator+. No
          content is published.
        </p>
        <Button size="sm" disabled={start.isPending || !sourceUrl.trim()} type="submit">
          {start.isPending ? "Starting…" : gridOnly ? "Extract every frame" : "Study reference"}
        </Button>
        {start.isError && (
          <p role="alert" className="text-sm">
            {start.error.message}
          </p>
        )}
      </form>
      <Button
        variant="outline"
        size="sm"
        disabled={references.isFetching || selected.isFetching}
        onClick={() => void client.invalidateQueries({ queryKey: ["content-references"] })}
      >
        Refresh references
      </Button>
      {references.isPending && <p role="status">Loading references…</p>}
      {references.isError && <p role="alert">{references.error.message}</p>}
      {selectedId && selected.isPending && <p role="status">Loading reference…</p>}
      {selectedId && selected.isError && <p role="alert">{selected.error.message}</p>}
      {!selectedId && references.isSuccess && !choices.length && (
        <p>No references yet. Paste a public Instagram link into Benny and ask to study it.</p>
      )}
      {!!choices.length && (
        <label className="block text-sm">
          Reference
          <select
            className="mt-2 block w-full rounded-lg border border-border bg-background p-2"
            value={current?.id || ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {!current && (
              <option value="" disabled>
                Choose a reference
              </option>
            )}
            {choices.map((row, index) => (
              <option key={row.id} value={row.id}>
                {row.evidence?.owner ? `@${row.evidence.owner}` : `Reference ${index + 1}`} ·{" "}
                {row.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {current && (
        <section
          className="min-w-0 space-y-4 rounded-xl border border-border p-4"
          aria-label="Reference analysis"
          data-reference-job-id={current.id}
        >
          <p role="status">
            {current.status === "queued"
              ? "Waiting to analyze"
              : current.status === "processing"
                ? "Studying the reference…"
                : current.status === "ready"
                  ? "Analysis ready"
                  : "Analysis could not finish"}
          </p>
          {current.error && <p role="alert">{current.error}</p>}
          {current.evidence?.sourceUrl && (
            <a
              className="text-sm underline"
              href={current.evidence.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open original reference
            </a>
          )}
          {current.gridUrl && (
            <div className="space-y-2">
              <img
                src={current.gridUrl}
                alt="Timestamped video frame grid"
                className="max-h-[50vh] w-full rounded-lg border border-border object-contain"
              />
              <p className="text-sm text-muted-foreground">
                {current.evidence?.grid?.includedFrameCount} of{" "}
                {current.evidence?.grid?.decodedFrameCount} decoded frames ·{" "}
                {current.evidence?.grid?.mode === "all" ? "Every frame" : "Sampled overview"}
              </p>
              <div className="flex flex-wrap gap-3 text-sm">
                <a
                  className="underline"
                  href={current.gridUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open full-size grid
                </a>
                <a
                  className="underline"
                  href={current.frameMetadataUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Frame timestamps
                </a>
              </div>
            </div>
          )}
          {current.evidence?.visuals.map((visual) => (
            <div key={visual.index} className="rounded-lg border border-border p-3">
              <h3 className="mb-2 text-sm font-medium">
                {current.evidence?.format === "carousel"
                  ? `Slide ${visual.index + 1}`
                  : "Visual structure"}
              </h3>
              <p className="whitespace-pre-wrap text-sm">{visual.description}</p>
            </div>
          ))}
          {current.evidence?.transcript && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">Speech transcript</summary>
              <p className="mt-2 whitespace-pre-wrap text-sm">{current.evidence.transcript}</p>
            </details>
          )}
          {!!current.evidence?.warnings.length && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {current.evidence.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          {current.status === "ready" && !!current.evidence?.visuals.length && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  onUse(
                    `Use completed reference analysis ${current.id} to create an original editable draft in my selected theme. Read its evidence and my Studio projects first. Ask me for the topic if needed.`,
                  )
                }
              >
                Create with Benny
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onUse(
                    `Use completed reference analysis ${current.id} to save a reusable editable template in my selected theme. Read its evidence and my Studio projects first. Use bracketed placeholders rather than copying the source's wording or footage.`,
                  )
                }
              >
                Make a template
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
