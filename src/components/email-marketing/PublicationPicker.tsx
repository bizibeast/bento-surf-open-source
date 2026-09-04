import { Check, ChevronDown, Plus, Settings } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { BentoIcon } from "@/components/BentoBrand";
import { FileDropzone } from "@/components/blocks/FileDropzone";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createNewsletterPublication } from "@/lib/newsletter.functions";
import { NEWSLETTER_TEMPLATES, type NewsletterTemplateId } from "@/lib/newsletter-templates";
import type { NewsletterPublicationSummary } from "@/lib/newsletter-publications";

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

function subscriberLabel(count: number) {
  return `${count} subscriber${count === 1 ? "" : "s"}`;
}

function PublicationAvatar({ publication }: { publication: NewsletterPublicationSummary }) {
  return (
    <Avatar className="size-7 border border-black/[0.06] bg-[#f2f4f8]">
      {publication.logoUrl ? <AvatarImage src={publication.logoUrl} alt="" /> : null}
      <AvatarFallback className="bg-[#f2f4f8]">
        <BentoIcon className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

export function PublicationPicker({
  publications,
  selectedPublicationId,
  onSelectPublication,
  onPublicationCreated,
  onOpenSettings,
  locked = false,
  loading = false,
  loadError,
}: {
  publications: NewsletterPublicationSummary[];
  selectedPublicationId: string | null;
  onSelectPublication: (publicationId: string) => void;
  onPublicationCreated: (publicationId: string) => void | Promise<void>;
  onOpenSettings?: () => void;
  locked?: boolean;
  loading?: boolean;
  loadError?: string | null;
}) {
  const selected = publications.find((publication) => publication.id === selectedPublicationId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [creationError, setCreationError] = useState("");

  const openDialog = () => {
    setCreationError("");
    setStep(1);
    setDialogOpen(true);
  };

  useEffect(() => {
    if (!loading && !locked && publications.length === 0) {
      setCreationError("");
      setStep(1);
      setDialogOpen(true);
    }
  }, [loading, locked, publications.length]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setCreationError("");
    try {
      const publication = await createNewsletterPublication({
        data: {
          title: form.title,
          description: form.description,
          senderName: form.senderName,
          replyToEmail: form.replyToEmail || null,
          postalAddress: form.postalAddress,
          logoUrl: form.logoUrl || null,
          defaultTemplateId: form.defaultTemplateId,
          status: "draft",
        },
      });
      await onPublicationCreated(publication.id);
      setDialogOpen(false);
      setForm(emptyForm);
    } catch (error) {
      setCreationError(error instanceof Error ? error.message : "Could not create publication.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {loading ? (
          <button
            type="button"
            disabled
            className="min-h-11 rounded-lg border border-black/[0.08] px-3 text-sm text-[#17213a]/50"
          >
            Loading publications…
          </button>
        ) : publications.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={
                  selected
                    ? `Select publication, ${selected.title}, ${subscriberLabel(selected.subscriberCount)}`
                    : "Select publication"
                }
                className="flex h-auto min-h-9 min-w-0 max-w-64 items-center gap-2 rounded-lg border border-black/[0.08] bg-white [padding:0.35rem_0.625rem] text-sm font-semibold text-[#17213a] shadow-sm outline-none hover:bg-[#f8f9fc] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
              >
                {selected ? <PublicationAvatar publication={selected} /> : null}
                <span className="min-w-0 flex-1 truncate text-left">
                  {selected?.title ?? "Select publication"}
                </span>
                <ChevronDown className="size-4 shrink-0 text-[#17213a]/45" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 rounded-xl p-1.5">
              {publications.map((publication) => (
                <DropdownMenuItem
                  key={publication.id}
                  aria-label={`${publication.title}, ${subscriberLabel(publication.subscriberCount)}`}
                  onSelect={() => onSelectPublication(publication.id)}
                  className="min-h-14 rounded-lg px-2.5 py-2"
                >
                  <PublicationAvatar publication={publication} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold" title={publication.title}>
                      {publication.title}
                    </span>
                    <span className="block text-xs text-[#17213a]/50">
                      {subscriberLabel(publication.subscriberCount)}
                    </span>
                  </span>
                  {publication.id === selectedPublicationId ? (
                    <span className="flex shrink-0 items-center gap-1">
                      {onOpenSettings ? (
                        <button
                          type="button"
                          aria-label={`Open settings for ${publication.title}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onOpenSettings();
                          }}
                          className="flex size-8 items-center justify-center rounded-lg text-[#17213a]/55 outline-none hover:bg-[#eef0f4] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30"
                        >
                          <Settings className="size-4" />
                        </button>
                      ) : null}
                      <Check className="size-4" aria-hidden="true" />
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                aria-label="Add publication"
                disabled={locked}
                onSelect={openDialog}
                className="min-h-11 rounded-lg px-3 font-semibold"
              >
                <Plus className="size-4" />
                Add publication
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : !loading ? (
          <button
            type="button"
            aria-label="Add publication"
            disabled={locked}
            onClick={openDialog}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3 text-sm font-semibold text-[#17213a] shadow-sm outline-none hover:bg-[#f8f9fc] focus-visible:ring-2 focus-visible:ring-[#3478f6]/30 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus className="size-4" />
            Add publication
          </button>
        ) : null}
      </div>

      {loadError ? (
        <p role="alert" className="text-xs text-red-600">
          {loadError}
        </p>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={(open) => !submitting && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-ui-display text-2xl">
              {publications.length ? "Add publication" : "Set up your publication"}
            </DialogTitle>
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
    </>
  );
}
