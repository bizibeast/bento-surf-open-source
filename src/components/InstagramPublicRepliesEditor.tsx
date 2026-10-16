import { useState } from "react";
import { micro } from "@/lib/micro-app-ui";

export function InstagramPublicRepliesEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (replies: string[]) => void;
}) {
  const [list, setList] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fields = Array.from({ length: 3 }, (_, index) => value[index] ?? "");

  function applyList() {
    const replies = list
      .split(/[,\r\n]+/)
      .map((reply) => reply.trim())
      .filter(Boolean);
    if (!replies.length || replies.length > 3) {
      setError("Add between 1 and 3 replies. Separate them with commas or new lines.");
      return;
    }
    if (replies.some((reply) => reply.length > 300)) {
      setError("Each public reply must be 300 characters or fewer.");
      return;
    }
    onChange(replies);
    setList("");
    setError(null);
  }

  return (
    <div className="min-w-0 space-y-3">
      <p className="text-xs text-muted-foreground">
        Add up to 3 replies. Bento rotates them. Each field is one reply; commas inside a field stay
        in that reply.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map((reply, index) => (
          <label key={index} className="min-w-0 text-xs font-semibold text-muted-foreground">
            Public reply {index + 1}
            <input
              value={reply}
              maxLength={300}
              onChange={(event) => {
                const next = [...fields];
                next[index] = event.target.value;
                onChange(next);
              }}
              className={`mt-1 ${micro.input}`}
              placeholder={index === 0 ? "Write a public reply" : "Optional reply"}
            />
          </label>
        ))}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer font-semibold">Paste comma-separated replies</summary>
        <div className="mt-3 space-y-2">
          <label className="block font-semibold">
            Reply list
            <textarea
              value={list}
              onChange={(event) => {
                setList(event.target.value);
                setError(null);
              }}
              rows={3}
              className={`mt-1 ${micro.input}`}
              placeholder="Sent it to your DMs, Check your messages, On its way"
            />
          </label>
          <p>
            Use commas or new lines between replies. Applying this list replaces the replies above.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={applyList}
            className="rounded-lg border border-border px-3 py-2 font-semibold text-foreground"
          >
            Apply reply list
          </button>
        </div>
      </details>
    </div>
  );
}
