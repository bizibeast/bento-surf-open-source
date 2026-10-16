import { useState } from "react";
import { Sparkles } from "lucide-react";
import { rewriteSchedulerText } from "@/lib/scheduler-assist.functions";
import { SOCIAL_PROVIDER_DEFINITIONS, type SchedulerConnection } from "@/lib/social-scheduler";

export function SchedulerRewrite({
  connection,
  body,
  onApply,
}: {
  connection: SchedulerConnection;
  body: string;
  onApply: (text: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [proposal, setProposal] = useState<{ source: string; body: string } | null>(null);
  const [error, setError] = useState("");
  const network = SOCIAL_PROVIDER_DEFINITIONS[connection.provider].name;
  return (
    <div className="my-3 space-y-2">
      <button
        type="button"
        disabled={pending || body.trim().length < 8 || body.length > 10000}
        title={`Rewrite for ${network} in your voice. Review before replacing your text.`}
        data-hover-guide={`Rewrite for ${network} in your voice. Review before replacing your text.`}
        className="inline-flex min-h-9 items-center gap-2 rounded-full border border-primary/20 bg-white px-3 text-xs font-semibold text-primary disabled:opacity-50"
        onClick={async () => {
          const source = body;
          setPending(true);
          setError("");
          try {
            const result = await rewriteSchedulerText({
              data: { connectionId: connection.id, body: source },
            });
            setProposal({ source, body: result.body });
          } catch (e) {
            setError(e instanceof Error ? e.message : "Rewrite unavailable.");
          } finally {
            setPending(false);
          }
        }}
      >
        <Sparkles className="size-3.5" />
        {pending ? "Rewriting…" : `Rewrite for ${network}`}
      </button>
      {proposal && (
        <div className="rounded-2xl border border-primary/20 bg-white p-4">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">
            Suggested rewrite · review before applying
          </p>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{proposal.body}</p>
          {body !== proposal.source && (
            <p className="mt-2 text-xs text-amber-700">
              Your text changed while this was being written. Rewrite again to use your latest
              version.
            </p>
          )}
          <div className="mt-3 flex gap-3 text-xs font-semibold">
            <button
              type="button"
              disabled={body !== proposal.source}
              className="rounded-lg bg-primary px-3 py-2 text-white disabled:opacity-50"
              onClick={() => {
                onApply(proposal.body);
                setProposal(null);
              }}
            >
              Use this version
            </button>
            <button type="button" onClick={() => setProposal(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
