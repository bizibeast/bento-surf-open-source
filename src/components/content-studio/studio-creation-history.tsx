import { useQuery } from "@tanstack/react-query";
import { getContentStudioHistory } from "@/lib/content-studio.functions";
import { reviewContentCreation } from "@/lib/content-creation-harness";
import type { StudioEntry } from "@/lib/content-studio";

export function StudioCreationHistory({
  workspaceId,
  entry,
}: {
  workspaceId: string;
  entry: StudioEntry;
}) {
  const query = useQuery({
    queryKey: ["content-creation-history", workspaceId, entry.id, entry.revision],
    queryFn: () => getContentStudioHistory({ data: { workspaceId, entryId: entry.id } }),
    enabled: entry.revision > 0,
    retry: false,
  });
  const review = reviewContentCreation(entry.document);
  const brief = entry.document.creation?.brief || query.data?.brief;
  return (
    <details className="studio-creation-history" open={Boolean(query.data?.conversationPath)}>
      <summary>Editing plan &amp; history</summary>
      {query.data?.conversationPath && (
        <a className="content-action" href={query.data.conversationPath}>
          Open Benny conversation
        </a>
      )}
      {brief && <p className="studio-muted">{brief}</p>}
      {query.error && (
        <p role="status">
          Conversation history could not be loaded.{" "}
          <button type="button" className="content-action" onClick={() => void query.refetch()}>
            Retry history
          </button>
        </p>
      )}
      {review.scenes.length > 0 && (
        <ol>
          {review.scenes.map((s) => (
            <li key={s.id}>
              <strong>{s.title}</strong>
              <span className="studio-muted">
                {" "}
                {s.start.toFixed(1)}–{s.end.toFixed(1)}s · {s.layout} · {s.motion}
              </span>
            </li>
          ))}
        </ol>
      )}
      {review.findings.length > 0 && (
        <ul aria-label="Editing checks">
          {review.findings.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      )}
      {query.data?.actions.length ? (
        <p className="studio-muted">
          {query.data.actions.length} saved action{query.data.actions.length === 1 ? "" : "s"} ·{" "}
          {query.data.actions.at(-1)?.status}. Open the conversation to review the requests and
          approvals.
        </p>
      ) : null}
    </details>
  );
}
