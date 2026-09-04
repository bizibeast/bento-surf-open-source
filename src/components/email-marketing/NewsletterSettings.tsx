import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FileDropzone } from "@/components/blocks/FileDropzone";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { configuredPublicOrigin, publicNewsletterPublicationPath } from "@/lib/application-urls";
import { NEWSLETTER_TEMPLATES, type NewsletterTemplateId } from "@/lib/newsletter-templates";

export type NewsletterSettingsPanel =
  "details" | "seo" | "branding" | "template" | "email" | "paid" | "advanced";

function visibleSettingsPanel(panel?: NewsletterSettingsPanel): NewsletterSettingsPanel {
  return panel === "branding" || panel === "template" ? "details" : (panel ?? "details");
}

export type NewsletterSettingsPublication = {
  id: string;
  title: string;
  slug?: string;
  description: string | null;
  sender_name: string;
  reply_to_email: string | null;
  postal_address: string;
  accent_color: string | null;
  logo_url?: string | null;
  status: string;
  is_default?: boolean;
  default_template_id?: NewsletterTemplateId;
  paidProduct?: { price_amount: number; currency: string; billing_interval: "month" | "year" };
};

const inputClass = "min-w-0 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm";

export function NewsletterSettings({
  publication,
  creatorUsername,
  focusedPanel,
  onFocusedPanelChange,
  onSave,
  onSavePaidOffer,
  onSetDefault,
  onArchive,
}: {
  publication: NewsletterSettingsPublication;
  creatorUsername?: string | null;
  focusedPanel?: NewsletterSettingsPanel;
  onFocusedPanelChange?: (panel: NewsletterSettingsPanel) => void;
  onSave: (
    input: Omit<NewsletterSettingsPublication, "id" | "is_default" | "paidProduct">,
  ) => void | Promise<void>;
  onSavePaidOffer: (input: {
    priceAmount: number;
    currency: string;
    billingInterval: "month" | "year";
  }) => void | Promise<void>;
  onSetDefault: () => void | Promise<void>;
  onArchive: (confirmation: string) => void | Promise<void>;
}) {
  const sections: Array<{ id: NewsletterSettingsPanel; label: string }> = [
    { id: "details", label: "General" },
    { id: "email", label: "Email defaults" },
    { id: "seo", label: "Website" },
    { id: "paid", label: "Subscription & payment" },
    { id: "advanced", label: "Advanced" },
  ];
  const [activeSection, setActiveSection] = useState<NewsletterSettingsPanel>(
    visibleSettingsPanel(focusedPanel),
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(() => ({
    title: publication.title,
    description: publication.description ?? "",
    sender_name: publication.sender_name,
    reply_to_email: publication.reply_to_email ?? "",
    postal_address: publication.postal_address,
    accent_color: publication.accent_color ?? "#3478f6",
    logo_url: publication.logo_url ?? "",
    status: publication.status,
    default_template_id: publication.default_template_id ?? "editorial",
  }));
  const [price, setPrice] = useState(String((publication.paidProduct?.price_amount ?? 0) / 100));
  const [currency, setCurrency] = useState(publication.paidProduct?.currency ?? "usd");
  const [billingInterval, setBillingInterval] = useState<"month" | "year">(
    publication.paidProduct?.billing_interval ?? "month",
  );
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (focusedPanel) setActiveSection(visibleSettingsPanel(focusedPanel));
  }, [focusedPanel]);
  const run = async (success: string, action: () => void | Promise<void>) => {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save settings.");
    } finally {
      setPending(false);
    }
  };
  const save = () =>
    void run("Settings saved", () =>
      onSave({
        ...form,
        reply_to_email: form.reply_to_email || null,
        accent_color: form.accent_color || null,
      }),
    );
  const savePaidOffer = () => {
    const priceAmount = Math.round(Number(price) * 100);
    if (Number.isInteger(priceAmount) && priceAmount > 0)
      void run("Paid access saved", () =>
        onSavePaidOffer({ priceAmount, currency, billingInterval }),
      );
  };

  return (
    <div
      className="grid gap-5 lg:grid-cols-[220px_minmax(0,720px)] lg:items-start"
      aria-busy={pending}
    >
      <nav
        aria-label="Publication settings"
        className="flex flex-wrap gap-2 rounded-[20px] border border-black/[0.07] bg-white p-2 shadow-sm lg:sticky lg:top-24 lg:flex-col"
      >
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => {
              setActiveSection(section.id);
              onFocusedPanelChange?.(section.id);
            }}
            aria-current={activeSection === section.id ? "page" : undefined}
            className={`min-h-10 rounded-xl px-3 text-left text-xs font-semibold ${
              activeSection === section.id
                ? "bg-[#17213a] text-white"
                : "text-[#17213a]/58 hover:bg-[#f3f4f6]"
            }`}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <Section
        active={activeSection === "details"}
        title="General"
        description="The name and description visitors see."
      >
        <FileDropzone
          kind="avatar"
          value={form.logo_url}
          onChange={(logo_url) => setForm({ ...form, logo_url })}
          label="Publication logo"
          className="max-w-52"
          rounded="2xl"
        />
        <p className="text-xs text-[#17213a]/50">
          Upload a square (1:1) image for the best result.
        </p>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Publication name
          <input
            aria-label="Publication name"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Description
          <textarea
            aria-label="Description"
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Publication status
          <select
            aria-label="Publication status"
            value={form.status}
            onChange={(event) => setForm({ ...form, status: event.target.value })}
            className={inputClass}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
        </label>
      </Section>
      <Section
        active={activeSection === "seo"}
        title="Website"
        description="How this publication appears on the web and in search results."
      >
        <div
          aria-label="Search result preview"
          className="rounded-2xl border border-black/[0.08] bg-white p-4"
        >
          {creatorUsername && publication.slug ? (
            <p className="break-all text-xs text-emerald-700">
              {configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}
              {publicNewsletterPublicationPath(creatorUsername, publication.slug)}
            </p>
          ) : null}
          <p className="mt-1 text-lg font-semibold text-[#245fd0]">{form.title}</p>
          {form.description ? (
            <p className="mt-1 text-sm text-[#17213a]/60">{form.description}</p>
          ) : null}
        </div>
        <p className="text-xs text-[#17213a]/48">
          Update the publication name and description in Page details to change this preview.
        </p>
      </Section>
      <Section
        active={activeSection === "branding"}
        title="Branding"
        description="Choose the archive accent color."
      >
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Accent color
          <input
            aria-label="Accent color"
            type="color"
            value={form.accent_color}
            onChange={(event) => setForm({ ...form, accent_color: event.target.value })}
            className="h-11 w-full rounded-xl border border-black/[0.08] bg-white p-1"
          />
        </label>
      </Section>
      <Section
        active={activeSection === "template"}
        title="Default template"
        description="Choose the starting design for new posts."
      >
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Default template
          <select
            aria-label="Default template"
            value={form.default_template_id}
            onChange={(event) =>
              setForm({ ...form, default_template_id: event.target.value as NewsletterTemplateId })
            }
            className={inputClass}
          >
            {NEWSLETTER_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
      </Section>
      <Section
        active={activeSection === "email"}
        title="Email defaults"
        description="Used in every email footer and reply flow."
      >
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Sender name
          <input
            aria-label="Sender name"
            value={form.sender_name}
            onChange={(event) => setForm({ ...form, sender_name: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Reply-to email
          <input
            aria-label="Reply-to email"
            type="email"
            value={form.reply_to_email}
            onChange={(event) => setForm({ ...form, reply_to_email: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Postal address
          <input
            aria-label="Postal address"
            value={form.postal_address}
            onChange={(event) => setForm({ ...form, postal_address: event.target.value })}
            className={inputClass}
          />
        </label>
      </Section>
      <Section
        active={activeSection === "paid"}
        title="Subscription & payment"
        description="Subscribers pay for access to paid posts in this publication."
      >
        <p className="text-sm text-[#17213a]/55">
          Stripe is required for checkout. Bento fee: 0%. Stripe processing fees are separate.
          Subscribers receive paid-post access after payment; account contact packs stay separate.
        </p>
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About Bento fees"
                className="w-fit text-[#17213a]/55"
              >
                <Info className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Provider processing fees vary by payment method.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
            Price
            <input
              aria-label="Paid price"
              type="number"
              min="0.01"
              step="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
            Currency
            <select
              aria-label="Currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              className={inputClass}
            >
              <option value="usd">USD</option>
              <option value="inr">INR</option>
              <option value="eur">EUR</option>
              <option value="gbp">GBP</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
            Billing interval
            <select
              aria-label="Billing interval"
              value={billingInterval}
              onChange={(event) => setBillingInterval(event.target.value as "month" | "year")}
              className={inputClass}
            >
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          onClick={savePaidOffer}
          disabled={pending}
          className="w-fit rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white"
        >
          Save paid access
        </button>
      </Section>
      <Section
        active={activeSection === "advanced"}
        title="Advanced"
        description="Default and archive controls for this publication."
      >
        {!publication.is_default ? (
          <button
            type="button"
            onClick={() => void run("Default publication updated", onSetDefault)}
            disabled={pending}
            className="w-fit rounded-xl border border-black/[0.08] px-4 py-2.5 text-xs font-semibold"
          >
            Set as default
          </button>
        ) : (
          <p className="text-sm text-[#17213a]/55">This is the default publication.</p>
        )}
        <p className="text-sm text-[#17213a]/55">
          Choose another default first. Your only publication cannot be archived.
        </p>
        <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
          Type {publication.title} to archive
          <input
            aria-label={`Type ${publication.title} to archive`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className={inputClass}
          />
        </label>
        <button
          type="button"
          disabled={confirmation !== publication.title}
          onClick={() => void run("Publication archived", () => onArchive(confirmation))}
          className="w-fit rounded-xl border border-red-200 px-4 py-2.5 text-xs font-semibold text-red-700 disabled:opacity-45"
        >
          Archive publication
        </button>
      </Section>
      <p aria-live="polite" role="status" className="text-sm text-[#17213a]/55 lg:col-start-2">
        {pending ? "Saving…" : message}
      </p>
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="w-fit rounded-xl bg-[#3478f6] px-4 py-2.5 text-xs font-semibold text-white lg:col-start-2"
      >
        Save settings
      </button>
    </div>
  );
}

function Section({
  active,
  title,
  description,
  children,
}: {
  active: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  if (!active) return null;
  return (
    <section className="grid gap-4 rounded-2xl border border-black/[0.06] bg-white p-5 shadow-sm sm:p-6 lg:col-start-2">
      <div>
        <h2 className="font-ui-display text-xl">{title}</h2>
        <p className="mt-1 text-sm text-[#17213a]/48">{description}</p>
      </div>
      {children}
    </section>
  );
}
