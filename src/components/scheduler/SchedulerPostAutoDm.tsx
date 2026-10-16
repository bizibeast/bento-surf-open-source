import type { ReactNode } from "react";
import { InstagramPublicRepliesEditor } from "@/components/InstagramPublicRepliesEditor";
import { micro } from "@/lib/micro-app-ui";
import { INSTAGRAM_AUTO_DM_DEFAULTS } from "@/lib/instagram-auto-dm-defaults";
import type {
  ScheduledPostAutoDmDraft,
  ScheduledPostAutoDmProvider,
} from "@/lib/scheduled-post-auto-dm";

export function SchedulerPostAutoDm({
  provider,
  value,
  onChange,
  blockReason,
}: {
  provider: ScheduledPostAutoDmProvider;
  value: ScheduledPostAutoDmDraft;
  onChange: (value: ScheduledPostAutoDmDraft) => void;
  blockReason?: string | null;
}) {
  const network = provider === "twitter" ? "X" : "Facebook";
  const update = (patch: Partial<ScheduledPostAutoDmDraft>) => onChange({ ...value, ...patch });
  const needsKeywords = value.triggerType.endsWith("_keyword");
  return (
    <section
      className="mt-5 rounded-2xl border border-border/70 bg-white/70 p-4"
      aria-label={`${network} post Auto DM`}
    >
      <Toggle checked={value.enabled} onChange={(enabled) => update({ enabled })}>
        Auto DM after this {network} post goes live
      </Toggle>
      <p className="mt-1 text-xs text-muted-foreground">
        Set it up now. Bento attaches this automation only to this post after {network} confirms it
        is published.
      </p>
      {value.enabled && (
        <div className="mt-4 space-y-3">
          {blockReason && (
            <p role="status" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-950">
              {blockReason} You can save the setup in your draft.
            </p>
          )}
          <Field label="Trigger">
            <select
              value={value.triggerType}
              onChange={(e) =>
                update({ triggerType: e.target.value as ScheduledPostAutoDmDraft["triggerType"] })
              }
              className={`scheduler-select ${micro.input}`}
            >
              {provider === "twitter" ? (
                <>
                  <option value="mention_keyword">Reply to this post with a keyword</option>
                  <option value="any_mention">Any reply to this post</option>
                  <option value="any_like">Like this post</option>
                  <option value="any_retweet">Repost this post</option>
                </>
              ) : (
                <>
                  <option value="comment_keyword">Comment on this post with a keyword</option>
                  <option value="any_comment">Any comment on this post</option>
                </>
              )}
            </select>
          </Field>
          {needsKeywords && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Keywords (comma separated)">
                <input
                  className={micro.input}
                  value={value.keywords}
                  onChange={(e) => update({ keywords: e.target.value })}
                  placeholder="link, guide"
                />
              </Field>
              <Field label="Match">
                <select
                  className={`scheduler-select ${micro.input}`}
                  value={value.matchType}
                  onChange={(e) => update({ matchType: e.target.value as "contains" | "exact" })}
                >
                  <option value="contains">Contains keyword</option>
                  <option value="exact">Exact reply</option>
                </select>
              </Field>
            </div>
          )}
          <Field label="Excluded keywords (comma separated)">
            <input
              className={micro.input}
              value={value.excludedKeywords}
              onChange={(e) => update({ excludedKeywords: e.target.value })}
              placeholder="spam, stop"
            />
          </Field>
          {provider === "facebook" && (
            <>
              <Field label="Opening message">
                <textarea
                  className={micro.input}
                  rows={2}
                  maxLength={1000}
                  value={value.openingMessage}
                  onChange={(e) => update({ openingMessage: e.target.value })}
                />
              </Field>
              <Field label="Opening reply button">
                <input
                  className={micro.input}
                  maxLength={20}
                  value={value.confirmationButtonLabel}
                  onChange={(e) => update({ confirmationButtonLabel: e.target.value })}
                />
              </Field>
              <Toggle
                checked={value.publicReplyEnabled}
                onChange={(publicReplyEnabled) =>
                  update({
                    publicReplyEnabled,
                    publicReplyMessages:
                      publicReplyEnabled && !value.publicReplyMessages.some((reply) => reply.trim())
                        ? [...INSTAGRAM_AUTO_DM_DEFAULTS.publicReplyMessages]
                        : value.publicReplyMessages,
                  })
                }
              >
                Reply publicly to matching comments
              </Toggle>
              {value.publicReplyEnabled && (
                <InstagramPublicRepliesEditor
                  value={value.publicReplyMessages}
                  onChange={(publicReplyMessages) => update({ publicReplyMessages })}
                />
              )}
              <Toggle
                checked={value.emailCaptureEnabled}
                onChange={(emailCaptureEnabled) => update({ emailCaptureEnabled })}
              >
                Ask for email before delivery
              </Toggle>
              {value.emailCaptureEnabled && (
                <>
                  <Field label="Email prompt">
                    <textarea
                      className={micro.input}
                      rows={2}
                      maxLength={700}
                      value={value.emailPromptMessage}
                      onChange={(e) => update({ emailPromptMessage: e.target.value })}
                    />
                  </Field>
                  <Toggle
                    checked={value.emailMarketingConsentEnabled}
                    onChange={(emailMarketingConsentEnabled) =>
                      update({ emailMarketingConsentEnabled })
                    }
                  >
                    Ask for permission to send marketing emails
                  </Toggle>
                </>
              )}
            </>
          )}
          <Field label={provider === "twitter" ? "DM reply" : "DM after they tap Send it"}>
            <textarea
              className={micro.input}
              rows={3}
              maxLength={provider === "twitter" ? 10000 : 1000}
              value={value.replyMessage}
              onChange={(e) => update({ replyMessage: e.target.value })}
            />
          </Field>
          {provider === "facebook" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Final link button text (optional)">
                <input
                  className={micro.input}
                  maxLength={20}
                  value={value.replyButtonLabel}
                  onChange={(e) => update({ replyButtonLabel: e.target.value })}
                  placeholder="Get the guide"
                />
              </Field>
              <Field label="Secure destination URL">
                <input
                  className={micro.input}
                  value={value.replyButtonUrl}
                  onChange={(e) => update({ replyButtonUrl: e.target.value })}
                  placeholder="https://…"
                />
              </Field>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Include your link in the DM. Delivery depends on the recipient’s message settings and
              your connected X account’s Auto DM access.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-muted-foreground">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-semibold">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
