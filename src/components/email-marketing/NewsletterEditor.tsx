import { ArrowLeft, ArrowRight, Check, Redo2, RotateCcw, Send, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isoToLocalDateTimeInput, localDateTimeInputToIso } from "@/lib/local-datetime";
import { newsletterContentSchema, type NewsletterContentBlock } from "@/lib/newsletter";
import { saveNewsletterIssue } from "@/lib/newsletter.functions";
import { resolveNewsletterTemplate, type NewsletterTemplateId } from "@/lib/newsletter-templates";
import {
  NewsletterDocument,
  type NewsletterDocumentProduct,
  type NewsletterPaidProduct,
} from "./NewsletterDocument";
import { NewsletterCanvas } from "./editor/NewsletterCanvas";

export interface NewsletterIssueRecord {
  id: string;
  publication_id: string | null;
  list_id: string | null;
  name: string;
  subject: string;
  preview_text: string | null;
  public_slug: string | null;
  web_visibility: "private" | "public" | "paid";
  status: string;
  delivery_status?: "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";
  scheduled_at?: string | null;
  template_id?: NewsletterTemplateId | null;
  content: NewsletterContentBlock[];
}

type IssueForm = {
  name: string;
  subject: string;
  previewText: string;
  listId: string;
  publicSlug: string;
  webVisibility: "private" | "public" | "paid";
  content: NewsletterContentBlock[];
};

type ComposerStep = "compose" | "audience" | "email" | "web" | "review";

function blankParagraph(): NewsletterContentBlock {
  return { id: crypto.randomUUID(), type: "paragraph", text: "" };
}

function initialForm(issue?: NewsletterIssueRecord): IssueForm {
  if (!issue) {
    return {
      name: "",
      subject: "",
      previewText: "",
      listId: "",
      publicSlug: "",
      webVisibility: "private",
      content: [blankParagraph()],
    };
  }
  return {
    name: issue.name,
    subject: issue.subject,
    previewText: issue.preview_text ?? "",
    listId: issue.list_id ?? "",
    publicSlug: issue.public_slug ?? "",
    webVisibility: issue.web_visibility,
    content: issue.content.length
      ? issue.content.map((block) => ({ ...block }))
      : [blankParagraph()],
  };
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-black/[0.08] bg-white px-3 text-sm outline-none focus:border-[#3478f6]/45 focus:ring-2 focus:ring-[#3478f6]/15";

export function NewsletterEditor({
  publicationId,
  issue,
  onSaved,
  mode = "newsletter",
  saveDocument,
  products = [],
  defaultTemplateId,
  publicationName = "this publication",
  publicationLogoUrl,
  recipientCount,
  recipientCounts,
  audienceLabel,
  audiences = [],
  onTestSend,
  onPublish,
  onBack,
}: {
  publicationId?: string;
  issue?: NewsletterIssueRecord;
  onSaved: () => void | Promise<void>;
  mode?: "newsletter" | "broadcast";
  saveDocument?: (input: {
    id?: string;
    name: string;
    subject: string;
    previewText: string;
    listId: string | null;
    content: NewsletterContentBlock[];
  }) => Promise<{ id: string }>;
  products?: NewsletterDocumentProduct[];
  defaultTemplateId?: NewsletterTemplateId;
  publicationName?: string;
  publicationLogoUrl?: string | null;
  postalAddress?: string;
  recipientCount?: number;
  recipientCounts?: Record<string, number>;
  audienceLabel?: string;
  audiences?: Array<{ id: string; name: string }>;
  onTestSend?: (postId: string) => void | Promise<void>;
  onPublish?: (input: { id: string; scheduledAt: string | null }) => void | Promise<void>;
  paidProduct?: NewsletterPaidProduct | null;
  onBack?: () => void;
}) {
  const initial = useRef(initialForm(issue));
  const [form, setForm] = useState(initial.current);
  const formRef = useRef(form);
  const history = useRef<IssueForm[]>([initial.current]);
  const historyIndex = useRef(0);
  const [historyPosition, setHistoryPosition] = useState(0);
  const [step, setStep] = useState<ComposerStep>("compose");
  const [surface, setSurface] = useState<"email" | "web">("email");
  const [issueId, setIssueId] = useState(issue?.id);
  const initialSchedule = useRef(isoToLocalDateTimeInput(issue?.scheduled_at ?? ""));
  const [scheduledAt, setScheduledAt] = useState(initialSchedule.current);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveState, setSaveState] = useState<"saving" | "saved" | "failed">("saved");
  const [failureMessage, setFailureMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const revision = useRef(0);
  const templateId = issue?.template_id ?? defaultTemplateId ?? null;
  const steps: ComposerStep[] =
    mode === "newsletter"
      ? ["compose", "audience", "email", "web", "review"]
      : ["compose", "audience", "email", "review"];
  const stepIndex = steps.indexOf(step);

  const markChanged = useCallback((next: IssueForm, trackHistory = true) => {
    formRef.current = next;
    setForm(next);
    revision.current += 1;
    setDirty(true);
    setSaveState("saving");
    setFailureMessage("");
    setActionMessage("");
    if (trackHistory) {
      history.current = [...history.current.slice(0, historyIndex.current + 1), next];
      historyIndex.current += 1;
      setHistoryPosition(historyIndex.current);
    }
  }, []);

  const change = useCallback(
    (update: (current: IssueForm) => IssueForm) => {
      const current = formRef.current;
      const next = update(current);
      if (next !== current) markChanged(next);
    },
    [markChanged],
  );

  const moveThroughHistory = (direction: -1 | 1) => {
    const nextIndex = historyIndex.current + direction;
    if (nextIndex < 0 || nextIndex >= history.current.length) return;
    historyIndex.current = nextIndex;
    setHistoryPosition(nextIndex);
    markChanged(history.current[nextIndex], false);
  };

  const canSave = useMemo(
    () =>
      Boolean(form.name.trim() && form.subject.trim()) &&
      (mode === "broadcast" ||
        form.webVisibility === "private" ||
        Boolean(form.publicSlug.trim())) &&
      newsletterContentSchema.safeParse(form.content).success,
    [form, mode],
  );

  const saveLabel =
    dirty && !canSave
      ? "Needs details"
      : saving
        ? "Saving"
        : saveState === "failed"
          ? "Failed"
          : scheduleDirty
            ? "Unsaved"
            : dirty
              ? "Saving"
              : "Saved";

  const save = useCallback(
    async (_status: "draft" | "published" = "draft") => {
      if (!canSave || savingRef.current) return undefined;
      const submitted = formRef.current;
      const savedRevision = revision.current;
      savingRef.current = true;
      setSaving(true);
      setSaveState("saving");
      setFailureMessage("");
      try {
        const saved = saveDocument
          ? await saveDocument({
              id: issueId,
              name: submitted.name,
              subject: submitted.subject,
              previewText: submitted.previewText,
              listId: submitted.listId || null,
              content: submitted.content,
            })
          : await saveNewsletterIssue({
              data: {
                id: issueId,
                publicationId: publicationId as string,
                templateId,
                listId: submitted.listId || null,
                name: submitted.name,
                subject: submitted.subject,
                previewText: submitted.previewText,
                publicSlug: submitted.publicSlug || null,
                webVisibility: submitted.webVisibility,
                content: submitted.content,
                status: "draft",
              },
            });
        setIssueId(saved.id);
        if (revision.current === savedRevision) {
          setDirty(false);
          setSaveState("saved");
        }
        await onSaved();
        return saved.id;
      } catch (error) {
        setSaveState("failed");
        setFailureMessage(error instanceof Error ? error.message : "Could not save this draft.");
        return undefined;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [canSave, issueId, onSaved, publicationId, saveDocument, templateId],
  );

  useEffect(() => {
    if (!dirty || !canSave || saving || saveState === "failed") return;
    const timer = window.setTimeout(() => void save("draft"), 800);
    return () => window.clearTimeout(timer);
  }, [canSave, dirty, save, saveState, saving]);

  useEffect(() => {
    if (!dirty && !scheduleDirty && !saving) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [dirty, scheduleDirty, saving]);

  const sendTest = async () => {
    const savedId = await save("draft");
    if (!savedId || !onTestSend) return;
    try {
      await onTestSend(savedId);
      setActionMessage("Test email queued");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not send the test email.");
    }
  };

  const publish = async () => {
    if (!onPublish || !canSave) return;
    let scheduledIso: string | null = null;
    if (scheduledAt) {
      try {
        scheduledIso = localDateTimeInputToIso(scheduledAt);
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : "Choose a valid schedule.");
        return;
      }
    }
    const audience =
      audienceLabel ??
      audiences.find((candidate) => candidate.id === form.listId)?.name ??
      "All subscribers";
    const resolvedRecipients = recipientCounts?.[form.listId || "all"] ?? recipientCount ?? 0;
    const access =
      mode === "broadcast"
        ? "Email only"
        : form.webVisibility === "paid"
          ? "Paid web access"
          : form.webVisibility === "public"
            ? "Public access (email and web)"
            : "Email only";
    const action = scheduledIso ? "Schedule" : mode === "broadcast" ? "Send" : "Publish";
    const schedule = scheduledIso ? new Date(scheduledIso).toLocaleString() : "Immediately";
    if (
      !window.confirm(
        action +
          ' "' +
          form.name +
          '" in ' +
          publicationName +
          "?\nTarget: " +
          audience +
          " · " +
          resolvedRecipients +
          " recipients\nAccess: " +
          access +
          "\nSchedule: " +
          schedule,
      )
    ) {
      return;
    }
    const savedId = await save("draft");
    if (!savedId) return;
    try {
      await onPublish({ id: savedId, scheduledAt: scheduledIso });
      initialSchedule.current = scheduledAt;
      setScheduleDirty(false);
      setActionMessage(
        scheduledIso
          ? mode === "broadcast"
            ? "Broadcast scheduled"
            : "Post scheduled"
          : mode === "broadcast"
            ? "Broadcast queued"
            : "Post published",
      );
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not deliver this post.");
    }
  };

  const nextStep = () => setStep(steps[Math.min(stepIndex + 1, steps.length - 1)]);
  const previousStep = () => setStep(steps[Math.max(stepIndex - 1, 0)]);

  return (
    <section className="min-w-0 overflow-hidden rounded-[26px] border border-black/[0.07] bg-[#f3f3f1] shadow-sm">
      <header className="sticky top-0 z-30 border-b border-black/[0.07] bg-white/95 backdrop-blur-xl">
        <div className="flex min-h-16 flex-wrap items-center gap-2 px-3 sm:px-5">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl px-2 text-xs font-semibold text-[#17213a]/60 outline-none hover:bg-[#f2f3f5] hover:text-[#17213a] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
            >
              <ArrowLeft className="size-4" />
              Back to posts
            </button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#17213a]/45">
            {form.name || "Untitled post"}
          </span>
          <div
            aria-live="polite"
            className="flex min-w-20 items-center gap-2 text-xs text-[#17213a]/48"
          >
            <span
              className={
                "size-2 rounded-full " +
                (saveLabel === "Saved"
                  ? "bg-emerald-500"
                  : saveLabel === "Failed" || saveLabel === "Needs details"
                    ? "bg-amber-500"
                    : "animate-pulse bg-[#3478f6]")
              }
            />
            <span>{saveLabel}</span>
            {saveState === "failed" ? (
              <button
                type="button"
                aria-label="Retry save"
                onClick={() => void save("draft")}
                className="font-semibold text-[#3478f6]"
              >
                <RotateCcw className="size-3.5" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Undo"
              disabled={historyPosition === 0}
              onClick={() => moveThroughHistory(-1)}
              className="flex size-9 items-center justify-center rounded-xl hover:bg-[#f2f3f5] disabled:opacity-30"
            >
              <Undo2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Redo"
              disabled={historyPosition === history.current.length - 1}
              onClick={() => moveThroughHistory(1)}
              className="flex size-9 items-center justify-center rounded-xl hover:bg-[#f2f3f5] disabled:opacity-30"
            >
              <Redo2 className="size-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={!canSave || saving || !onTestSend}
            className="hidden min-h-10 items-center gap-1.5 rounded-xl border border-black/[0.08] px-3 text-xs font-semibold disabled:opacity-45 lg:inline-flex"
          >
            <Send className="size-3.5" />
            Send test
          </button>
        </div>

        <div className="flex min-h-14 items-center border-t border-black/[0.06] px-3 sm:px-5">
          <div
            role="tablist"
            aria-label="Publishing steps"
            className="flex min-w-0 flex-1 items-center overflow-x-auto"
          >
            {steps.map((composerStep, index) => (
              <button
                key={composerStep}
                type="button"
                role="tab"
                aria-selected={step === composerStep}
                onClick={() => setStep(composerStep)}
                className={
                  "flex min-h-12 shrink-0 items-center gap-2 px-3 text-xs font-semibold capitalize outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3478f6]/30 " +
                  (step === composerStep ? "text-[#17213a]" : "text-[#17213a]/38")
                }
              >
                <span
                  className={
                    "flex size-5 items-center justify-center rounded-full text-[10px] " +
                    (index < stepIndex
                      ? "bg-emerald-100 text-emerald-700"
                      : step === composerStep
                        ? "bg-[#17213a] text-white"
                        : "bg-[#eef0f3] text-[#17213a]/45")
                  }
                >
                  {index < stepIndex ? <Check className="size-3" /> : index + 1}
                </span>
                <span className={step === composerStep ? undefined : "hidden sm:inline"}>
                  {composerStep}
                </span>
              </button>
            ))}
          </div>
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={previousStep}
              className="hidden min-h-10 items-center gap-1 rounded-xl px-3 text-xs font-semibold sm:inline-flex"
            >
              <ArrowLeft className="size-3.5" />
              Back
            </button>
          ) : null}
          {step !== "review" ? (
            <button
              type="button"
              onClick={nextStep}
              className="inline-flex min-h-10 items-center gap-1 rounded-xl bg-[#17213a] px-3 text-xs font-semibold text-white"
            >
              Next
              <ArrowRight className="size-3.5" />
            </button>
          ) : null}
        </div>
        {failureMessage ? (
          <p className="border-t border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
            {failureMessage}
          </p>
        ) : actionMessage ? (
          <p className="border-t border-black/[0.06] px-5 py-2 text-xs text-[#17213a]/55">
            {actionMessage}
          </p>
        ) : null}
      </header>

      {step === "compose" ? (
        <div className="p-3 sm:p-6 lg:p-8">
          <div
            data-testid="post-surface-switch-slot"
            className="mb-5 grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_260px]"
          >
            <div className="flex justify-center">
              <div
                role="tablist"
                aria-label="Post surface"
                className="inline-flex rounded-md border border-black/[0.08] bg-white p-1 shadow-sm"
              >
                {(["email", "web"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={surface === option}
                    onClick={() => setSurface(option)}
                    className={`min-h-9 rounded-sm px-4 text-xs font-semibold capitalize outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/30 ${surface === option ? "bg-[#17213a] text-white" : "text-[#17213a]/55"}`}
                  >
                    {option} post
                  </button>
                ))}
              </div>
            </div>
          </div>
          {surface === "email" ? (
            <NewsletterCanvas
              title={form.name}
              onTitleChange={(name) => change((current) => ({ ...current, name }))}
              publicationName={publicationName}
              publicationLogoUrl={publicationLogoUrl}
              content={form.content}
              products={products}
              presentation={resolveNewsletterTemplate(templateId)?.presentation}
              onChange={(content) => change((current) => ({ ...current, content }))}
            />
          ) : (
            <div
              className="rounded-2xl p-3 sm:p-5"
              style={{
                backgroundColor:
                  resolveNewsletterTemplate(templateId)?.presentation.canvasColor ?? "#eef0f4",
              }}
            >
              <NewsletterDocument
                content={form.content}
                subject={form.name || "Untitled post"}
                previewText={form.previewText}
                products={products}
                presentation={resolveNewsletterTemplate(templateId)?.presentation}
              />
            </div>
          )}
        </div>
      ) : step === "audience" ? (
        <WorkflowPanel
          eyebrow="Audience"
          title={
            mode === "broadcast" ? "Who should receive this email?" : "Choose where this post goes"
          }
          description="Keep the decision simple. Bento checks consent and eligibility again before delivery."
        >
          {mode === "newsletter" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                {
                  value: "public",
                  label: "Email and web",
                  detail: "Send it and publish a public page.",
                },
                { value: "private", label: "Email only", detail: "Send it without a public post." },
                {
                  value: "paid",
                  label: "Paid web post",
                  detail: "Only paid subscribers can read online.",
                },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={form.webVisibility === option.value}
                  onClick={() =>
                    change((current) => ({
                      ...current,
                      webVisibility: option.value as IssueForm["webVisibility"],
                    }))
                  }
                  className={
                    "rounded-2xl border p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/30 " +
                    (form.webVisibility === option.value
                      ? "border-[#3478f6]/45 bg-[#f4f8ff]"
                      : "border-black/[0.08] bg-white")
                  }
                >
                  <span className="block font-semibold text-[#17213a]">{option.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-[#17213a]/48">
                    {option.detail}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="mt-5 grid gap-2 text-sm font-semibold text-[#17213a]">
            Email audience
            <select
              aria-label="Audience"
              value={form.listId}
              onChange={(event) =>
                change((current) => ({ ...current, listId: event.target.value }))
              }
              className={inputClass}
            >
              <option value="">All subscribers</option>
              {audiences.map((audience) => (
                <option key={audience.id} value={audience.id}>
                  {audience.name}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-3 text-sm text-[#17213a]/48">
            {recipientCounts?.[form.listId || "all"] ?? recipientCount ?? 0} eligible recipients
          </p>
        </WorkflowPanel>
      ) : step === "email" ? (
        <WorkflowPanel
          eyebrow="Email"
          title="Make the inbox version clear"
          description="The subject and preview text are what readers see before opening."
        >
          <label className="grid gap-2 text-sm font-semibold text-[#17213a]">
            Subject line
            <input
              aria-label="Subject"
              value={form.subject}
              maxLength={180}
              onChange={(event) =>
                change((current) => ({ ...current, subject: event.target.value }))
              }
              className={inputClass}
            />
            <span className="text-right text-xs font-normal text-[#17213a]/38">
              {form.subject.length}/180
            </span>
          </label>
          <label className="mt-5 grid gap-2 text-sm font-semibold text-[#17213a]">
            Preview text
            <input
              aria-label="Preview text"
              value={form.previewText}
              maxLength={240}
              onChange={(event) =>
                change((current) => ({ ...current, previewText: event.target.value }))
              }
              className={inputClass}
            />
            <span className="text-right text-xs font-normal text-[#17213a]/38">
              {form.previewText.length}/240
            </span>
          </label>
          <div className="mt-5 rounded-xl bg-[#f4f5f7] p-4 text-sm text-[#17213a]/55">
            Sending as <strong className="text-[#17213a]">{publicationName}</strong>. Reply-to and
            postal address come from publication settings.
          </div>
        </WorkflowPanel>
      ) : step === "web" ? (
        <WorkflowPanel
          eyebrow="Web"
          title="Set up the newsletter page"
          description="These details control the public post URL and who can read it."
        >
          <label className="grid gap-2 text-sm font-semibold text-[#17213a]">
            Post slug
            <div className="flex min-h-11 items-center rounded-xl border border-black/[0.08] bg-white pl-3 focus-within:border-[#3478f6]/45">
              <span className="text-sm text-[#17213a]/38">/posts/</span>
              <input
                aria-label="Post slug"
                value={form.publicSlug}
                maxLength={96}
                onChange={(event) =>
                  change((current) => ({ ...current, publicSlug: event.target.value }))
                }
                className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm outline-none"
              />
            </div>
          </label>
          <label className="mt-5 grid gap-2 text-sm font-semibold text-[#17213a]">
            Web visibility
            <select
              aria-label="Web visibility"
              value={form.webVisibility}
              onChange={(event) =>
                change((current) => ({
                  ...current,
                  webVisibility: event.target.value as IssueForm["webVisibility"],
                }))
              }
              className={inputClass}
            >
              <option value="public">Public</option>
              <option value="paid">Paid subscribers</option>
              <option value="private">Email only</option>
            </select>
          </label>
          <div className="mt-6 rounded-2xl border border-black/[0.08] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#17213a]/38">
              Search preview
            </p>
            <p className="mt-3 text-sm text-emerald-700">
              {publicationName.toLowerCase().replaceAll(" ", "-") + "/posts/" + form.publicSlug}
            </p>
            <p className="mt-1 text-lg font-semibold text-[#4b3bad]">
              {form.name || "Untitled post"}
            </p>
            <p className="mt-1 text-sm text-[#17213a]/55">{form.previewText}</p>
          </div>
        </WorkflowPanel>
      ) : (
        <WorkflowPanel
          eyebrow="Review"
          title="Review and publish"
          description="One last check before Bento sends or schedules this post."
        >
          <div className="grid gap-3">
            <ReviewRow
              label="Publication"
              value={publicationName}
              onEdit={() => setStep("compose")}
            />
            <ReviewRow
              label="Post title"
              value={form.name || "Missing title"}
              onEdit={() => setStep("compose")}
            />
            <ReviewRow
              label="Subject line"
              value={form.subject || "Missing subject"}
              onEdit={() => setStep("email")}
            />
            <ReviewRow
              label="Audience"
              value={
                audiences.find((candidate) => candidate.id === form.listId)?.name ??
                "All subscribers"
              }
              onEdit={() => setStep("audience")}
            />
            {mode === "newsletter" ? (
              <ReviewRow
                label="Web access"
                value={
                  form.webVisibility === "public"
                    ? "Public"
                    : form.webVisibility === "paid"
                      ? "Paid subscribers"
                      : "Email only"
                }
                onEdit={() => setStep("web")}
              />
            ) : null}
          </div>
          <label className="mt-5 grid gap-2 text-sm font-semibold text-[#17213a]">
            Schedule
            <input
              aria-label="Schedule"
              type="datetime-local"
              value={scheduledAt}
              disabled={!onPublish}
              onChange={(event) => {
                setScheduledAt(event.target.value);
                setScheduleDirty(event.target.value !== initialSchedule.current);
              }}
              className={inputClass}
            />
          </label>
          {!canSave ? (
            <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Add the missing title, subject, valid links, and web slug before publishing.
            </p>
          ) : null}
          {onPublish ? (
            <button
              type="button"
              disabled={!canSave || saving}
              onClick={() => void publish()}
              className="mt-6 min-h-12 w-full rounded-xl bg-[#17213a] px-5 text-sm font-semibold text-white disabled:opacity-45"
            >
              {scheduledAt ? "Schedule" : mode === "broadcast" ? "Send broadcast" : "Publish post"}
            </button>
          ) : null}
        </WorkflowPanel>
      )}
    </section>
  );
}

function WorkflowPanel({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#3478f6]">{eyebrow}</p>
      <h2 className="mt-2 font-ui-display text-3xl text-[#17213a]">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-[#17213a]/52">{description}</p>
      <div className="mt-8 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-sm sm:p-7">
        {children}
      </div>
    </div>
  );
}

function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex min-h-16 w-full items-center justify-between gap-4 rounded-xl border border-black/[0.07] px-4 text-left hover:bg-[#f8f9fa]"
    >
      <span className="text-sm text-[#17213a]/48">{label}</span>
      <span className="min-w-0 truncate text-sm font-semibold text-[#17213a]">{value}</span>
      <ArrowRight className="size-4 shrink-0 text-[#17213a]/30" />
    </button>
  );
}
