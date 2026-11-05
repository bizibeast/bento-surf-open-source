import { useState } from "react";
import { X_THREAD_MAX_POSTS, LINKEDIN_FIRST_COMMENT_LIMIT } from "@/lib/scheduler-follow-ups";
import { xPostTextLength } from "@/lib/x-account";

export function SchedulerThreadReplies({
  replies,
  onChange,
}: {
  replies: string[];
  onChange: (replies: string[] | null) => void;
}) {
  return (
    <section
      aria-label="Thread replies"
      className="mt-5 space-y-4 rounded-2xl border border-border/70 p-4"
    >
      <p className="text-sm font-semibold">Thread · {replies.length + 1} posts</p>
      <p className="text-xs text-muted-foreground">
        Each post replies to the previous one. Attachments go on the first post. No X Premium
        needed.
      </p>
      {replies.map((reply, index) => (
        <div key={index}>
          <label className="block text-xs font-semibold">
            <span className="flex justify-between">
              <span>Thread post {index + 2}</span>
              <span
                className={
                  xPostTextLength(reply) > 280 ? "text-destructive" : "text-muted-foreground"
                }
              >
                {xPostTextLength(reply)}/280
              </span>
            </span>
            <textarea
              aria-label={`Thread post ${index + 2}`}
              value={reply}
              rows={3}
              onChange={(event) =>
                onChange(replies.map((part, i) => (i === index ? event.target.value : part)))
              }
              className="mt-2 w-full rounded-xl border border-border bg-transparent p-3 text-sm font-normal"
            />
          </label>
          <button
            type="button"
            className="mt-1 text-xs text-muted-foreground"
            onClick={() =>
              onChange(replies.length === 1 ? null : replies.filter((_, i) => i !== index))
            }
          >
            Remove post {index + 2}
          </button>
        </div>
      ))}
      <div className="flex gap-4 text-xs font-semibold">
        <button
          type="button"
          disabled={replies.length >= X_THREAD_MAX_POSTS - 1}
          onClick={() => onChange([...replies, ""])}
        >
          Add post to thread
        </button>
        <button type="button" onClick={() => onChange(null)}>
          Remove thread replies
        </button>
      </div>
    </section>
  );
}

export function SchedulerFirstComment({
  value,
  onChange,
  canComment,
}: {
  value: string;
  onChange: (value: string) => void;
  canComment: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!expanded && !value)
    return (
      <button
        type="button"
        className="mt-5 text-xs font-semibold"
        onClick={() => setExpanded(true)}
      >
        Add first comment
      </button>
    );
  return (
    <section className="mt-5 rounded-2xl border border-border/70 p-4">
      <label className="block text-xs font-semibold">
        <span className="flex justify-between">
          <span>First comment</span>
          <span className="text-muted-foreground">
            {value.length}/{LINKEDIN_FIRST_COMMENT_LIMIT.toLocaleString()}
          </span>
        </span>
        <textarea
          aria-label="First comment"
          value={value}
          maxLength={LINKEDIN_FIRST_COMMENT_LIMIT}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
          className="mt-2 w-full rounded-xl border border-border bg-transparent p-3 text-sm font-normal"
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        Added from this LinkedIn account after your post goes live. Other people may comment before
        it appears.
      </p>
      {!canComment && (
        <p className="mt-2 text-xs text-amber-700">
          Reconnect LinkedIn with comment access before scheduling a first comment. You can save it
          as a draft.
        </p>
      )}
      <button
        type="button"
        className="mt-2 text-xs text-muted-foreground"
        onClick={() => {
          onChange("");
          setExpanded(false);
        }}
      >
        Remove first comment
      </button>
    </section>
  );
}
