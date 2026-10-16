import { useState } from "react";
import { Button } from "@/components/ui/button";
import { storedContentAgentResultSchema } from "@/lib/content-agent-proactive";

export function ProactiveMessageFeedback({
  payload,
  onFeedback,
}: {
  payload: unknown;
  onFeedback(feedback: "useful" | "not_relevant" | "less_like_this"): Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const parsed = storedContentAgentResultSchema.safeParse(payload);
  const proactive = parsed.success ? parsed.data.proactive : undefined;
  if (!proactive) return null;
  async function submit(value: "useful" | "not_relevant" | "less_like_this") {
    setPending(true);
    setError("");
    try {
      await onFeedback(value);
    } catch {
      setError("Feedback could not be saved. Please try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mt-3 space-y-2 border-t pt-3 text-xs text-muted-foreground">
      <p>
        <span className="font-medium">Why now: </span>
        {proactive.whyNow}
      </p>
      <div className="flex flex-wrap items-center gap-2" aria-label="Message feedback">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={proactive.feedback === "useful"}
          disabled={pending}
          onClick={() => void submit("useful")}
        >
          Useful
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={proactive.feedback === "not_relevant"}
          disabled={pending}
          onClick={() => void submit("not_relevant")}
        >
          Not relevant
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={proactive.feedback === "less_like_this"}
          disabled={pending || !proactive.topicKeys.length}
          onClick={() => void submit("less_like_this")}
        >
          Less like this
        </Button>
        {proactive.feedback === "less_like_this" && (
          <span>Got it. I’ll suggest less about this topic.</span>
        )}
        {proactive.feedback === "not_relevant" && (
          <span>Got it. I’ll avoid this source in future suggestions.</span>
        )}
        {proactive.feedback === "useful" && <span>Thanks for the feedback.</span>}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
