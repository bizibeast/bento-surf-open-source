import { type FormEvent, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDropzone } from "@/components/blocks/FileDropzone";
import { NewsletterSettings } from "@/components/email-marketing/NewsletterSettings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createNewsletterPublication,
  getMyNewsletterPublication,
  updateNewsletterPublication,
  savePaidNewsletterOffer,
  setDefaultNewsletterPublication,
  archiveNewsletterPublication,
} from "@/lib/newsletter.functions";
import { NEWSLETTER_TEMPLATES, type NewsletterTemplateId } from "@/lib/newsletter-templates";

const inputClass =
  "min-w-0 rounded-lg border border-black/[0.08] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#3478f6]/45 focus:ring-2 focus:ring-[#3478f6]/15";
const emptyForm = {
  title: "",
  description: "",
  senderName: "",
  replyToEmail: "",
  postalAddress: "",
  logoUrl: "",
  defaultTemplateId: "editorial" as NewsletterTemplateId,
};

type NewsletterProductBuilderProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (publicationId: string) => void | Promise<void>;
  publicationId?: string;
  creationTitle?: string;
};

/** Both Products and Newsletter use the publication lifecycle, including its
 * separate paid-offer validation; newsletter is never a generic product kind. */
export function NewsletterProductBuilder(props: NewsletterProductBuilderProps) {
  return props.publicationId ? (
    <EditNewsletterPublication {...props} publicationId={props.publicationId} />
  ) : (
    <CreateNewsletterPublication {...props} />
  );
}

function CreateNewsletterPublication({
  open,
  onOpenChange,
  onSaved,
  creationTitle = "New newsletter",
}: NewsletterProductBuilderProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [creationError, setCreationError] = useState("");

  const [createdPublicationId, setCreatedPublicationId] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCreationError("");
      setStep(1);
    }
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setCreationError("");
    try {
      const input = {
        data: {
          title: form.title,
          description: form.description,
          senderName: form.senderName,
          replyToEmail: form.replyToEmail || null,
          postalAddress: form.postalAddress,
          logoUrl: form.logoUrl || null,
          defaultTemplateId: form.defaultTemplateId,
          status: "draft" as const,
        },
      };
      const publication = createdPublicationId
        ? await updateNewsletterPublication({
            data: { ...input.data, publicationId: createdPublicationId },
          })
        : await createNewsletterPublication(input);
      setCreatedPublicationId(publication.id);
      await onSaved?.(publication.id);
      onOpenChange(false);
      setCreatedPublicationId(null);
      setForm(emptyForm);
    } catch (error) {
      setCreationError(error instanceof Error ? error.message : "Could not create publication.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-ui-display text-2xl">{creationTitle}</DialogTitle>
          <DialogDescription>
            Create a focused home for a distinct newsletter and its subscribers.
          </DialogDescription>
        </DialogHeader>
        <div className="mb-1 flex gap-2" aria-label="Publication setup steps">
          {["Basics", "Identity", "Template"].map((label, index) => (
            <span
              key={label}
              className={`h-1 flex-1 rounded-full ${index + 1 <= step ? "bg-[#3478f6]" : "bg-[#e5e7eb]"}`}
              aria-label={`${label}${index + 1 === step ? ", current step" : ""}`}
            />
          ))}
        </div>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          {step === 1 ? (
            <>
              <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/65">
                Publication name
                <input
                  required
                  maxLength={120}
                  value={form.title}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, title: event.target.value }))
                  }
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/65">
                Description
                <textarea
                  required
                  maxLength={1000}
                  rows={3}
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                  className={inputClass}
                />
              </label>
            </>
          ) : null}
          {step === 2 ? (
            <>
              <FileDropzone
                kind="avatar"
                value={form.logoUrl}
                onChange={(logoUrl) => setForm((current) => ({ ...current, logoUrl }))}
                label="Publication logo"
                className="mx-auto w-full max-w-56"
                rounded="2xl"
              />
              <p className="text-center text-xs text-[#17213a]/50">
                Upload a square (1:1) image for the best result.
              </p>
              <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/65">
                Sender name
                <input
                  required
                  maxLength={120}
                  value={form.senderName}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, senderName: event.target.value }))
                  }
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/65">
                Reply-to email
                <input
                  type="email"
                  maxLength={254}
                  value={form.replyToEmail}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, replyToEmail: event.target.value }))
                  }
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/65">
                Postal address
                <textarea
                  required
                  maxLength={500}
                  rows={2}
                  value={form.postalAddress}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, postalAddress: event.target.value }))
                  }
                  className={inputClass}
                />
              </label>
            </>
          ) : null}
          {step === 3 ? (
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="col-span-full text-xs font-semibold text-[#17213a]/65">
                Default template
              </legend>
              {NEWSLETTER_TEMPLATES.slice(0, 6).map((template) => (
                <label
                  key={template.id}
                  className={`cursor-pointer rounded-xl border p-3 ${form.defaultTemplateId === template.id ? "border-[#3478f6] bg-[#eef5ff]" : "border-black/[0.08]"}`}
                >
                  <input
                    type="radio"
                    name="default-template"
                    value={template.id}
                    checked={form.defaultTemplateId === template.id}
                    onChange={() =>
                      setForm((current) => ({ ...current, defaultTemplateId: template.id }))
                    }
                    className="sr-only"
                  />
                  <span className="block text-sm font-semibold">{template.name}</span>
                  <span className="mt-1 block text-xs text-[#17213a]/50">
                    {template.description}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {creationError ? (
            <p
              role="alert"
              aria-label="Publication creation error"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {creationError}
            </p>
          ) : null}
          <DialogFooter>
            {step > 1 ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => setStep((current) => current - 1)}
                className="min-h-11 rounded-lg border border-black/[0.08] px-4 text-sm font-semibold"
              >
                Back
              </button>
            ) : null}
            {step < 3 ? (
              <button
                type="button"
                disabled={
                  submitting ||
                  (step === 1 && (!form.title.trim() || !form.description.trim())) ||
                  (step === 2 && (!form.senderName.trim() || !form.postalAddress.trim()))
                }
                onClick={() => setStep((current) => current + 1)}
                className="min-h-11 rounded-lg bg-[#17213a] px-4 text-sm font-semibold text-white disabled:opacity-45"
              >
                Continue
              </button>
            ) : null}
            {step === 3 ? (
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#17213a] px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6]/35 disabled:opacity-45"
              >
                {submitting ? "Creating publication…" : "Create publication"}
              </button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditNewsletterPublication({
  open,
  onOpenChange,
  onSaved,
  publicationId,
}: NewsletterProductBuilderProps & { publicationId: string }) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const query = useQuery({
    queryKey: ["newsletter-publication", publicationId],
    queryFn: () => getMyNewsletterPublication({ data: { publicationId } }),
    enabled: open,
  });
  const saved = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["newsletter-publication", publicationId] }),
        client.invalidateQueries({ queryKey: ["newsletter-publications"] }),
        client.invalidateQueries({ queryKey: ["my-email-marketing"] }),
      ]);
      await onSaved?.(publicationId);
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Manage newsletter</DialogTitle>
          <DialogDescription>
            Publication details, email identity and subscription access.
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <p role="status">Loading newsletter…</p>
        ) : query.error && !query.data?.publication ? (
          <div role="alert">
            <p>
              {query.error instanceof Error ? query.error.message : "Could not load newsletter."}
            </p>
            <button type="button" onClick={() => void query.refetch()}>
              Try again
            </button>
          </div>
        ) : query.data?.publication ? (
          <NewsletterSettings
            key={publicationId}
            publication={query.data.publication}
            creatorUsername={query.data.creatorUsername}
            onSave={(input) =>
              saved(() =>
                updateNewsletterPublication({
                  data: {
                    publicationId,
                    title: input.title,
                    description: input.description ?? "",
                    senderName: input.sender_name,
                    replyToEmail: input.reply_to_email || null,
                    postalAddress: input.postal_address,
                    accentColor: input.accent_color || null,
                    logoUrl: input.logo_url || null,
                    defaultTemplateId: input.default_template_id,
                    status: input.status === "published" ? "published" : "draft",
                  },
                }),
              )
            }
            onSavePaidOffer={(input) =>
              saved(() => savePaidNewsletterOffer({ data: { publicationId, ...input } }))
            }
            onSetDefault={() =>
              saved(() => setDefaultNewsletterPublication({ data: { publicationId } }))
            }
            onArchive={(confirmation) =>
              saved(() => archiveNewsletterPublication({ data: { publicationId, confirmation } }))
            }
          />
        ) : (
          <p role="alert">Newsletter publication not found.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
