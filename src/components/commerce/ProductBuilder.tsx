import { STORE_TEMPLATE_DRAFTS } from "@/lib/product-website";
import { ProductWebsiteEditor } from "@/components/commerce/ProductWebsiteEditor";
import { DEFAULT_COMMERCE_CURRENCY, type CommerceCurrency } from "@/lib/commerce-currency";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  BadgePercent,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  GraduationCap,
  Loader2,
  MessagesSquare,
  Newspaper,
  PackageOpen,
  Plus,
  Radio,
  Repeat2,
  Send,
  Upload,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { FileDropzone } from "@/components/blocks/FileDropzone";
import { PriceInput } from "@/components/commerce/PriceInput";
import { ProductBlockPreview } from "@/components/commerce/ProductBlockPreview";
import { uploadFileResult } from "@/lib/upload";
import {
  bookingAvailabilitySettings,
  DEFAULT_AVAILABILITY,
  type Availability,
  type WeeklyRule,
} from "@/lib/booking";
import { creatorPaymentCompatibility, type CreatorPaymentProvider } from "@/lib/payment-providers";
import { browserTimeZone } from "@/lib/timezones";
import { isoToZonedDateTimeInput, zonedDateTimeInputToIso } from "@/lib/local-datetime";
import { clampProductBuilderStep, productBuilderSteps } from "@/lib/product-builder-steps";
import { createCommerceProduct, updateCommerceProduct } from "@/lib/commerce.functions";
import {
  commerceKind,
  commerceProductRequiresPayment,
  type CommerceAsset,
  type CommerceLesson,
  type CommercePricingType,
  type CommerceProductKind,
  type CommerceProductRecord,
  type CommerceProductSettings,
} from "@/lib/commerce";

const PRODUCT_ICONS: Record<CommerceProductKind, typeof PackageOpen> = {
  digital_product: PackageOpen,
  coaching_call: MessagesSquare,
  course: GraduationCap,
  webinar: Radio,
  paid_community: UsersRound,
  membership: Repeat2,
  custom_product: Wrench,
  priority_dm: Send,
  bundle: PackageOpen,
  newsletter: Newspaper,
  lead_form: ClipboardList,
  bento_affiliate: BadgePercent,
};

export type ProductDraft = {
  kind: CommerceProductKind;
  title: string;
  subtitle: string;
  description: string;
  cover_url: string | null;
  pricing_type: CommercePricingType;
  price_amount: number;
  currency: string;
  billing_interval: "day" | "week" | "month" | "year" | null;
  cta_label: string;
  settings: CommerceProductSettings;
  inventory_limit: number | null;
  noindex: boolean;
};

export function draftFor(
  kind: CommerceProductKind,
  existing?: CommerceProductRecord,
  bookingAvailability?: Availability,
  defaultCurrency: CommerceCurrency = DEFAULT_COMMERCE_CURRENCY,
): ProductDraft {
  const definition = commerceKind(kind);
  if (existing) {
    const settings = { ...(existing.settings || {}) };
    const detectedTimeZone = browserTimeZone();
    if (
      kind === "coaching_call" &&
      !Array.isArray(settings.weeklyRules) &&
      !Array.isArray(settings.availabilityDays)
    ) {
      Object.assign(
        settings,
        bookingAvailabilitySettings(bookingAvailability || DEFAULT_AVAILABILITY),
      );
    }
    if (kind === "webinar") settings.timezone = detectedTimeZone;
    if (kind === "webinar" && settings.startsAt) {
      settings.startsAt = isoToZonedDateTimeInput(String(settings.startsAt), detectedTimeZone);
    }
    if (kind === "priority_dm") {
      settings.freeFollowUpLimit ??= 0;
      settings.followUpPriceAmount ??= existing.price_amount;
    }
    return {
      kind,
      title: existing.title || "",
      subtitle: existing.subtitle || "",
      description: existing.description || "",
      cover_url: existing.cover_url || null,
      pricing_type: existing.pricing_type,
      price_amount: Number(existing.price_amount || 0),
      currency: existing.currency || "usd",
      billing_interval: existing.billing_interval || null,
      cta_label: existing.cta_label || definition.defaultCta,
      settings,
      inventory_limit: existing.inventory_limit || null,
      noindex: existing.noindex ?? true,
    };
  }
  const settings: CommerceProductSettings = {};
  if (kind === "digital_product") settings.files = [];
  if (kind === "coaching_call")
    Object.assign(settings, {
      durationMinutes: 60,
      ...bookingAvailabilitySettings(bookingAvailability || DEFAULT_AVAILABILITY),
      availabilitySummary: "Uses your Calendar availability",
      recordingAddonEnabled: false,
      recordingAddonPrice: 1900,
    });
  if (kind === "course") settings.lessons = [];
  if (kind === "webinar")
    Object.assign(settings, {
      startsAt: "",
      timezone: browserTimeZone(),
      durationMinutes: 60,
      joinUrl: "",
      replayUrl: "",
    });
  if (kind === "paid_community")
    Object.assign(settings, { welcomeMessage: "", rules: "Be kind. Share generously." });
  if (kind === "membership") settings.benefits = ["Member-only updates"];
  if (kind === "custom_product")
    Object.assign(settings, { fulfillmentInstructions: "", buyerQuestions: [] });
  if (kind === "priority_dm")
    Object.assign(settings, {
      priorityPrompt: "What would you like to ask?",
      responseTimeHours: 48,
      freeFollowUpLimit: 1,
      followUpPriceAmount: 1900,
    });
  if (kind === "bundle") settings.bundledProductIds = [];
  if (kind === "lead_form")
    Object.assign(settings, {
      fields: [{ id: "email", label: "Email", type: "email", required: true }],
      confirmationMessage: "You're in. Thank you.",
    });
  const template = STORE_TEMPLATE_DRAFTS[kind];
  return {
    kind,
    title: template?.title || "",
    subtitle: template?.subtitle || "",
    description: template?.description || "",
    cover_url: null,
    pricing_type: definition.defaultPricing,
    price_amount: definition.defaultPricing === "free" ? 0 : 1900,
    currency: defaultCurrency,
    billing_interval: definition.defaultPricing === "subscription" ? "month" : null,
    cta_label: definition.defaultCta,
    settings,
    inventory_limit: null,
    noindex: true,
  };
}

function productDraftForSave(draft: ProductDraft): ProductDraft {
  if (draft.kind !== "webinar" || !draft.settings.startsAt) return draft;
  const startsAt = zonedDateTimeInputToIso(
    String(draft.settings.startsAt),
    String(draft.settings.timezone || ""),
  );
  if (!startsAt) return draft;
  return {
    ...draft,
    settings: {
      ...draft.settings,
      startsAt,
    },
  };
}

export function ProductBuilder({
  open,
  kind,
  product,
  profile,
  bookingAvailability,
  bookingAvailabilityLoading,
  products,
  paymentProvider,
  defaultCurrency,
  defaultCurrencyLoading,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  kind?: CommerceProductKind;
  product?: CommerceProductRecord;
  profile?: {
    theme?: string | null;
    accent_color?: string | null;
  } | null;
  bookingAvailability?: Availability;
  bookingAvailabilityLoading?: boolean;
  products: CommerceProductRecord[];
  paymentProvider: CreatorPaymentProvider | null;
  defaultCurrency: CommerceCurrency;
  defaultCurrencyLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (product: CommerceProductRecord) => void | Promise<void>;
}) {
  // A preference refresh supplies the next new product's currency; it must
  // never replace an already initialized draft or the creator's chosen price.
  const initialKey = `${kind}:${product?.id ?? "new"}`;
  const [draft, setDraft] = useState<ProductDraft | null>(() =>
    kind ? draftFor(kind, product, bookingAvailability, defaultCurrency) : null,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const initializedDraftKey = useRef<string | null>(null);
  useEffect(() => {
    if (kind === "coaching_call" && bookingAvailabilityLoading) return;
    if (!product && defaultCurrencyLoading) return;
    if (initializedDraftKey.current === initialKey) return;
    initializedDraftKey.current = initialKey;
    setDraft(kind ? draftFor(kind, product, bookingAvailability, defaultCurrency) : null);
    setStepIndex(0);
  }, [
    initialKey,
    kind,
    product,
    bookingAvailability,
    bookingAvailabilityLoading,
    defaultCurrency,
    defaultCurrencyLoading,
  ]);
  const definition = kind ? commerceKind(kind) : null;
  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Product is not ready.");
      const productDraft = productDraftForSave(draft);
      if (product)
        return updateCommerceProduct({ data: { id: product.id, product: productDraft } });
      const created = await createCommerceProduct({
        data: { product: productDraft, addToBento: true, pageId: null },
      });
      return created.product;
    },
    onSuccess: async (saved) => {
      toast.success(product ? "Product saved" : "Product published and block created");
      await onSaved(saved as CommerceProductRecord);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save product"),
  });
  if (
    !draft ||
    !definition ||
    (!product && defaultCurrencyLoading) ||
    (kind === "coaching_call" && bookingAvailabilityLoading)
  ) {
    return null;
  }
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const setSetting = <K extends keyof CommerceProductSettings>(
    key: K,
    value: CommerceProductSettings[K],
  ) => set("settings", { ...draft.settings, [key]: value });
  const paid = !["lead_form", "bento_affiliate"].includes(draft.kind);
  const steps = productBuilderSteps(paid);
  const activeStepIndex = clampProductBuilderStep(stepIndex, steps.length);
  const activeStep = steps[activeStepIndex];
  const isLastStep = activeStepIndex === steps.length - 1;
  const compatibility = creatorPaymentCompatibility(
    paymentProvider || "disabled",
    draft.kind,
    commerceProductRequiresPayment(draft) && draft.pricing_type === "free"
      ? "one_time"
      : draft.pricing_type,
    { billingInterval: draft.billing_interval, currency: draft.currency },
  );
  const oneTimeOnly = draft.kind === "priority_dm" || draft.kind === "bundle";
  const enforcesPublication = !product || product.status === "published";
  const pricingError =
    oneTimeOnly && draft.pricing_type !== "one_time"
      ? "Priority messages and bundles use one-time pricing."
      : enforcesPublication && !compatibility.supported
        ? compatibility.reason
        : draft.pricing_type !== "free" && draft.price_amount <= 0
          ? "Enter a price greater than zero."
          : null;
  const canContinue =
    activeStep.id === "basics"
      ? Boolean(draft.title.trim() && draft.description.trim())
      : activeStep.id === "page"
        ? Boolean(draft.cta_label.trim())
        : activeStep.id === "pricing"
          ? !pricingError
          : true;
  const canSave = Boolean(
    draft.title.trim() && draft.description.trim() && draft.cta_label.trim() && !pricingError,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl gap-0 overflow-hidden rounded-[24px] border-white/80 bg-[#f7f8fc] p-0 shadow-[0_42px_130px_-45px_rgba(23,33,58,.7)] sm:h-[min(92dvh,860px)] sm:rounded-[32px] [&>button]:z-40">
        <DialogTitle className="sr-only">
          {product ? "Edit" : "Create"} {definition.label}
        </DialogTitle>
        <div className="grid size-full min-h-0 overflow-hidden rounded-[22px] sm:rounded-[30px] lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="relative hidden overflow-hidden rounded-l-[30px] bg-[#17213a] p-7 text-white lg:flex lg:flex-col">
            <div
              className="absolute -right-24 -top-20 size-56 rounded-full blur-2xl"
              style={{ background: `${definition.accent}66` }}
            />
            <div className="relative text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35">
              Product builder · Step {activeStepIndex + 1} of {steps.length}
            </div>
            <h2 className="relative mt-2 font-ui-display text-4xl leading-[1.02]">
              {definition.label}
            </h2>
            <p className="relative mt-3 text-sm leading-6 text-white/50">{definition.setupHint}</p>
            <div className="relative mt-auto">
              <ProductBlockPreview
                product={{ ...draft, id: product?.id, slug: product?.slug }}
                profile={profile ?? undefined}
                compact
              />
            </div>
          </aside>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!isLastStep) {
                if (canContinue) setStepIndex((current) => current + 1);
                return;
              }
              save.mutate();
            }}
            className="flex min-h-0 flex-col overflow-hidden rounded-r-[30px]"
          >
            <div className="flex min-w-0 items-center gap-3 border-b border-black/[0.06] bg-white px-4 py-3 pr-14 sm:px-7 sm:py-4">
              <span
                className="flex size-10 items-center justify-center rounded-2xl text-white lg:hidden"
                style={{ background: definition.accent }}
              >
                {(() => {
                  const Icon = PRODUCT_ICONS[draft.kind];
                  return <Icon className="size-4" />;
                })()}
              </span>
              <div className="min-w-0">
                <div className="truncate font-ui-display text-lg sm:text-xl">
                  {product ? "Edit" : "Create"} {definition.label.toLowerCase()}
                </div>
                <div className="text-xs text-[#17213a]/45">
                  Step {activeStepIndex + 1} of {steps.length} · {activeStep.title}
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
              <div className="mx-auto max-w-3xl space-y-6">
                {activeStep.id === "page" && (
                  <div className="lg:hidden">
                    <ProductBlockPreview
                      product={{ ...draft, id: product?.id, slug: product?.slug }}
                      profile={profile ?? undefined}
                    />
                  </div>
                )}
                {activeStep.id === "basics" && (
                  <FormSection eyebrow="Basics" title="Make the offer clear">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Title">
                        <input
                          autoFocus
                          required
                          maxLength={120}
                          value={draft.title}
                          onChange={(event) => set("title", event.target.value)}
                          className={inputClass}
                          placeholder={definition.label}
                        />
                      </Field>
                      <Field label="Short line">
                        <input
                          maxLength={180}
                          value={draft.subtitle}
                          onChange={(event) => set("subtitle", event.target.value)}
                          className={inputClass}
                          placeholder="What makes it worth clicking?"
                        />
                      </Field>
                    </div>
                    <Field label="Description">
                      <textarea
                        required
                        maxLength={20_000}
                        value={draft.description}
                        onChange={(event) => set("description", event.target.value)}
                        className={`${inputClass} min-h-32 resize-y`}
                        placeholder="Tell buyers exactly what they get and who it is for."
                      />
                    </Field>
                    <FileDropzone
                      kind="cover"
                      value={draft.cover_url || ""}
                      onChange={(url) => set("cover_url", url || null)}
                      label="Product cover"
                      className="max-w-sm"
                    />
                  </FormSection>
                )}

                {activeStep.id === "pricing" && paid && (
                  <FormSection eyebrow="Price" title="Choose how people pay">
                    {pricingError && (
                      <p
                        role="alert"
                        className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"
                      >
                        {pricingError}
                      </p>
                    )}
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field label="Pricing">
                        <select
                          value={draft.pricing_type}
                          onChange={(event) => {
                            const next = event.target.value as CommercePricingType;
                            setDraft({
                              ...draft,
                              pricing_type: next,
                              price_amount: next === "free" ? 0 : Math.max(draft.price_amount, 100),
                              billing_interval:
                                next === "subscription" ? draft.billing_interval || "month" : null,
                            });
                          }}
                          className={inputClass}
                        >
                          <option value="one_time">One-time</option>
                          {!oneTimeOnly && <option value="subscription">Recurring</option>}
                          {!oneTimeOnly && <option value="free">Free</option>}
                          {oneTimeOnly && draft.pricing_type !== "one_time" && (
                            <option value={draft.pricing_type} disabled>
                              {draft.pricing_type === "free" ? "Free" : "Recurring"} (unsupported
                              for this offer)
                            </option>
                          )}
                        </select>
                      </Field>
                      <Field label="Price">
                        <PriceInput
                          amount={draft.price_amount}
                          disabled={draft.pricing_type === "free"}
                          onAmountChange={(amount) => set("price_amount", amount)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Currency">
                        <select
                          value={draft.currency}
                          onChange={(event) => set("currency", event.target.value)}
                          className={inputClass}
                        >
                          <option value="usd">USD</option>
                          <option value="inr">INR</option>
                          <option value="eur">EUR</option>
                          <option value="gbp">GBP</option>
                          <option value="aud">AUD</option>
                          <option value="cad">CAD</option>
                        </select>
                      </Field>
                    </div>
                    {draft.pricing_type === "subscription" && (
                      <Field label="Renews every">
                        <select
                          value={draft.billing_interval || "month"}
                          onChange={(event) =>
                            set(
                              "billing_interval",
                              event.target.value as ProductDraft["billing_interval"],
                            )
                          }
                          className={inputClass}
                        >
                          <option value="day">Day</option>
                          <option value="week">Week</option>
                          <option value="month">Month</option>
                          <option value="year">Year</option>
                        </select>
                      </Field>
                    )}
                    <div className="rounded-2xl bg-[#dceaff] px-4 py-3 text-xs leading-5 text-[#245fd0]">
                      Bento platform fee: 0% on every plan. Your payment provider’s processing or
                      merchant-of-record fees remain separate.
                    </div>
                  </FormSection>
                )}

                {activeStep.id === "details" && (
                  <SpecificProductFields
                    draft={draft}
                    setSetting={setSetting}
                    products={products}
                    currentProductId={product?.id}
                  />
                )}

                {activeStep.id === "page" && (
                  <FormSection eyebrow="Page" title="Design your sales page">
                    <ProductWebsiteEditor
                      kind={draft.kind}
                      legacyBuyerQuestions={draft.settings.buyerQuestions}
                      value={draft.settings.website}
                      onChange={(website) => setSetting("website", website)}
                      title={draft.title}
                      subtitle={draft.subtitle}
                      cover={draft.cover_url}
                    />
                    <Field label="What buyers get (one benefit per line)">
                      <textarea
                        rows={4}
                        className={inputClass}
                        value={(draft.settings.benefits || []).join("\n")}
                        onChange={(event) =>
                          setSetting("benefits", event.target.value.split("\n").slice(0, 30))
                        }
                        placeholder="Describe the value, not the file names"
                      />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Button label">
                        <input
                          required
                          maxLength={40}
                          value={draft.cta_label}
                          onChange={(event) => set("cta_label", event.target.value)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Inventory limit (optional)">
                        <input
                          type="number"
                          min="1"
                          max="1000000"
                          value={draft.inventory_limit ?? ""}
                          onChange={(event) =>
                            set(
                              "inventory_limit",
                              event.target.value ? Number(event.target.value) : null,
                            )
                          }
                          className={inputClass}
                          placeholder="Unlimited"
                        />
                      </Field>
                    </div>
                    <div className="flex items-start justify-between gap-6 rounded-2xl border border-black/[0.07] bg-[#f8faff] p-4">
                      <div>
                        <div className="text-sm font-semibold text-[#17213a]">
                          Show in search engines
                        </div>
                        <p className="mt-1 text-xs leading-5 text-[#17213a]/52">
                          Allow Google and other search engines to index this product page.
                        </p>
                      </div>
                      <Switch
                        aria-label="Show this product in search engines"
                        checked={!draft.noindex}
                        onCheckedChange={(showInSearch) => set("noindex", !showInSearch)}
                      />
                    </div>
                  </FormSection>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] bg-white px-4 py-3 sm:px-8 sm:py-4">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-semibold text-[#17213a]/55 hover:bg-[#f2f5fb]"
              >
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <span className="hidden text-xs font-semibold text-[#17213a]/35 sm:block">
                  {activeStepIndex + 1} / {steps.length}
                </span>
                <button
                  type="button"
                  disabled={activeStepIndex === 0}
                  onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
                  aria-label="Previous step"
                  className="inline-flex size-10 items-center justify-center rounded-lg border border-black/[0.07] bg-[#f2f5fb] text-[#17213a]/60 transition-colors hover:bg-[#e8eef9] disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="submit"
                  disabled={save.isPending || (isLastStep ? !canSave : !canContinue)}
                  className="inline-flex min-w-28 items-center justify-center gap-2 rounded-lg bg-[#3478f6] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#2168e5] disabled:opacity-50"
                >
                  {save.isPending && <Loader2 className="size-4 animate-spin" />}
                  {isLastStep ? (product ? "Save changes" : "Create product") : "Next"}
                  {!isLastStep && <ChevronRight className="size-4" />}
                </button>
              </div>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const inputClass =
  "w-full rounded-2xl border border-black/[0.07] bg-white px-4 py-3 text-sm text-[#17213a] outline-none transition placeholder:text-[#17213a]/28 focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10 disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

export function FormSection({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-black/[0.06] bg-white p-5 shadow-[0_20px_50px_-45px_rgba(23,33,58,.5)] sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
        {eyebrow}
      </div>
      <h3 className="mt-1 font-ui-display text-2xl">{title}</h3>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-[#17213a]/55">{label}</span>
      {children}
    </label>
  );
}

function coachingRules(settings: CommerceProductSettings): WeeklyRule[] {
  if (Array.isArray(settings.weeklyRules)) return settings.weeklyRules;
  return (settings.availabilityDays || []).map((day) => ({
    day,
    start: settings.availabilityStart || "09:00",
    end: settings.availabilityEnd || "17:00",
  }));
}

export function SpecificProductFields({
  draft,
  setSetting,
  products = [],
  currentProductId,
}: {
  draft: ProductDraft;
  products?: CommerceProductRecord[];
  currentProductId?: string;
  setSetting: <K extends keyof CommerceProductSettings>(
    key: K,
    value: CommerceProductSettings[K],
  ) => void;
}) {
  if (draft.kind === "digital_product")
    return (
      <FormSection eyebrow="Delivery" title="Upload what buyers receive">
        <ProductAssetUploader
          files={draft.settings.files || []}
          onChange={(files) => setSetting("files", files)}
        />
      </FormSection>
    );
  if (draft.kind === "coaching_call")
    return (
      <FormSection eyebrow="Booking" title="Set the call details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Duration (minutes)">
            <input
              type="number"
              min="10"
              value={draft.settings.durationMinutes || 60}
              onChange={(e) => setSetting("durationMinutes", Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Available days">
          <div className="flex flex-wrap gap-2">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => {
              const rules = coachingRules(draft.settings);
              const selected = rules.some((rule) => rule.day === day);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    const firstRule = rules[0];
                    setSetting(
                      "weeklyRules",
                      selected
                        ? rules.filter((rule) => rule.day !== day)
                        : [
                            ...rules,
                            {
                              day,
                              start: firstRule?.start || "09:00",
                              end: firstRule?.end || "17:00",
                            },
                          ].sort((left, right) => left.day - right.day),
                    );
                  }}
                  className={`rounded-xl px-3 py-2 text-xs font-semibold transition ${
                    selected
                      ? "bg-[#3478f6] text-white"
                      : "border border-black/[0.07] bg-[#f7f8fc] text-[#17213a]/50"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="From">
            <input
              type="time"
              value={coachingRules(draft.settings)[0]?.start || "09:00"}
              onChange={(e) =>
                setSetting(
                  "weeklyRules",
                  coachingRules(draft.settings).map((rule) => ({
                    ...rule,
                    start: e.target.value,
                  })),
                )
              }
              className={inputClass}
            />
          </Field>
          <Field label="Until">
            <input
              type="time"
              value={coachingRules(draft.settings)[0]?.end || "17:00"}
              onChange={(e) =>
                setSetting(
                  "weeklyRules",
                  coachingRules(draft.settings).map((rule) => ({
                    ...rule,
                    end: e.target.value,
                  })),
                )
              }
              className={inputClass}
            />
          </Field>
          <Field label="Slot spacing">
            <select
              value={draft.settings.slotIntervalMinutes || 30}
              onChange={(e) => setSetting("slotIntervalMinutes", Number(e.target.value))}
              className={inputClass}
            >
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">60 minutes</option>
            </select>
          </Field>
        </div>
        <Field label="Availability">
          <textarea
            value={draft.settings.availabilitySummary || ""}
            onChange={(e) => setSetting("availabilitySummary", e.target.value)}
            className={`${inputClass} min-h-24`}
            placeholder="Mon–Thu, 10am–4pm. Exact slots are selected after purchase."
          />
        </Field>
        <div className="rounded-2xl border border-black/[0.07] bg-[#f7f8fc] p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={Boolean(draft.settings.recordingAddonEnabled)}
              onChange={(e) => setSetting("recordingAddonEnabled", e.target.checked)}
              className="mt-1 size-4 accent-[#3478f6]"
            />
            <span>
              <span className="block text-sm font-semibold">Offer a Fathom recording</span>
              <span className="mt-1 block text-xs leading-5 text-[#17213a]/48">
                Customers can add the private call recording during checkout.{" "}
                <Link
                  to="/settings"
                  search={{ section: "integrations", integration: "bookings" }}
                  className="font-semibold text-[#3478f6]"
                >
                  Connect Fathom in Settings
                </Link>{" "}
                before enabling this on a live session.
              </span>
            </span>
          </label>
          {draft.settings.recordingAddonEnabled && (
            <div className="mt-4 max-w-xs">
              <Field label="Recording price">
                <PriceInput
                  amount={Number(draft.settings.recordingAddonPrice || 0)}
                  onAmountChange={(amount) => setSetting("recordingAddonPrice", amount)}
                />
              </Field>
            </div>
          )}
        </div>
        <Field label="Fallback meeting link (optional)">
          <input
            value={draft.settings.meetingUrl || ""}
            onChange={(e) => setSetting("meetingUrl", e.target.value)}
            className={inputClass}
            placeholder="https://meet.google.com/..."
          />
        </Field>
      </FormSection>
    );
  if (draft.kind === "course")
    return (
      <FormSection eyebrow="Course" title="Build the first lessons">
        <CourseLessonEditor
          lessons={draft.settings.lessons || []}
          onChange={(lessons) => setSetting("lessons", lessons)}
        />
      </FormSection>
    );
  if (draft.kind === "webinar")
    return (
      <FormSection eyebrow="Event" title="Set the live experience">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts at">
            <input
              type="datetime-local"
              value={draft.settings.startsAt || ""}
              onChange={(e) => setSetting("startsAt", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="max-w-xs">
          <Field label="Duration (minutes)">
            <input
              type="number"
              min="10"
              max="480"
              value={draft.settings.durationMinutes || 60}
              onChange={(e) => setSetting("durationMinutes", Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Private join link">
          <input
            value={draft.settings.joinUrl || ""}
            onChange={(e) => setSetting("joinUrl", e.target.value)}
            className={inputClass}
            placeholder="Revealed only to paid attendees"
          />
        </Field>
        <Field label="Replay link (optional)">
          <input
            value={draft.settings.replayUrl || ""}
            onChange={(e) => setSetting("replayUrl", e.target.value)}
            className={inputClass}
          />
        </Field>
      </FormSection>
    );
  if (draft.kind === "paid_community")
    return (
      <FormSection eyebrow="Community" title="Welcome paying members">
        <Field label="Welcome message">
          <textarea
            value={draft.settings.welcomeMessage || ""}
            onChange={(e) => setSetting("welcomeMessage", e.target.value)}
            className={`${inputClass} min-h-28`}
            placeholder="What members will find inside"
          />
        </Field>
        <Field label="Community rules">
          <textarea
            value={draft.settings.rules || ""}
            onChange={(e) => setSetting("rules", e.target.value)}
            className={`${inputClass} min-h-24`}
          />
        </Field>
      </FormSection>
    );
  if (draft.kind === "membership")
    return (
      <FormSection eyebrow="Membership" title="Make the recurring value obvious">
        <ListEditor
          values={draft.settings.benefits || []}
          onChange={(values) => setSetting("benefits", values)}
          placeholder="Member benefit"
          addLabel="Add benefit"
        />
      </FormSection>
    );
  if (draft.kind === "custom_product")
    return (
      <FormSection eyebrow="Fulfilment" title="Explain what happens next">
        <Field label="Fulfilment instructions">
          <textarea
            value={draft.settings.fulfillmentInstructions || ""}
            onChange={(e) => setSetting("fulfillmentInstructions", e.target.value)}
            className={`${inputClass} min-h-28`}
            placeholder="For example: delivery within five business days by email."
          />
        </Field>
        <ListEditor
          values={draft.settings.buyerQuestions || []}
          onChange={(values) => setSetting("buyerQuestions", values)}
          placeholder="Question for the buyer"
          addLabel="Add question"
        />
      </FormSection>
    );
  if (draft.kind === "priority_dm")
    return (
      <FormSection eyebrow="Priority inbox" title="Set the reply promise">
        <Field label="Message prompt">
          <input
            maxLength={500}
            value={draft.settings.priorityPrompt || ""}
            onChange={(event) => setSetting("priorityPrompt", event.target.value)}
            className={inputClass}
            placeholder="What would you like to ask?"
          />
        </Field>
        <Field label="Reply within (hours)">
          <input
            type="number"
            min="1"
            max="720"
            required
            value={draft.settings.responseTimeHours || 48}
            onChange={(event) => setSetting("responseTimeHours", Number(event.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Included free buyer follow-ups">
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={draft.settings.freeFollowUpLimit ?? 0}
            onChange={(event) => setSetting("freeFollowUpLimit", Number(event.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Paid follow-up price">
          <PriceInput
            amount={draft.settings.followUpPriceAmount ?? draft.price_amount}
            ariaLabel="Paid follow-up price"
            onAmountChange={(amount) => setSetting("followUpPriceAmount", amount)}
            className={inputClass}
          />
        </Field>
        <div className="rounded-2xl bg-[#eef5ff] px-4 py-3 text-xs leading-5 text-[#245fd0]">
          Paid requests appear in your standalone Priority DM inbox. Email notifications let you
          reply directly, or reply from Bento and the buyer receives your response by email.
        </div>
      </FormSection>
    );
  if (draft.kind === "bundle") {
    const eligibleProducts = products.filter(
      (product) =>
        product.status === "published" &&
        product.id !== currentProductId &&
        ["digital_product", "course", "custom_product"].includes(product.kind),
    );
    const selected = new Set(draft.settings.bundledProductIds || []);
    return (
      <FormSection eyebrow="Bundle" title="Choose included products">
        {eligibleProducts.length ? (
          <div className="space-y-2">
            {eligibleProducts.map((product) => (
              <label
                key={product.id}
                className="flex cursor-pointer items-center gap-3 rounded-2xl border border-black/[0.07] bg-[#f8faff] p-4"
              >
                <input
                  type="checkbox"
                  checked={selected.has(product.id)}
                  onChange={(event) =>
                    setSetting(
                      "bundledProductIds",
                      event.target.checked
                        ? [...selected, product.id]
                        : [...selected].filter((id) => id !== product.id),
                    )
                  }
                  className="size-4 accent-[#3478f6]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{product.title}</span>
                  <span className="text-xs text-[#17213a]/45">
                    {commerceKind(product.kind).label}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm leading-6 text-[#17213a]/50">
            Publish at least two downloads, courses, or custom products before creating a bundle.
          </p>
        )}
      </FormSection>
    );
  }
  if (draft.kind === "lead_form")
    return (
      <FormSection eyebrow="Form" title="Choose what you collect">
        <ListEditor
          values={(draft.settings.fields || []).map((field) => field.label)}
          onChange={(values) =>
            setSetting(
              "fields",
              values.map((label, index) => ({
                id: index === 0 ? "email" : `field-${index + 1}`,
                label,
                type: index === 0 ? "email" : "text",
                required: index === 0,
              })),
            )
          }
          placeholder="Field label"
          addLabel="Add field"
        />
        <Field label="Success message">
          <input
            value={draft.settings.confirmationMessage || ""}
            onChange={(e) => setSetting("confirmationMessage", e.target.value)}
            className={inputClass}
          />
        </Field>
      </FormSection>
    );
  return (
    <FormSection eyebrow="Referral" title="Bento tracks the referral">
      <div className="rounded-2xl bg-[#fff3c6] px-4 py-4 text-sm leading-6 text-[#7b5800]">
        The public block points to Bento signup with your creator attribution. Clicks are recorded
        immediately; commission eligibility and payout rules remain centrally controlled by Bento.
      </div>
    </FormSection>
  );
}

function ListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        <div key={index} className="flex gap-2">
          <input
            value={value}
            onChange={(e) =>
              onChange(
                values.map((item, itemIndex) => (itemIndex === index ? e.target.value : item)),
              )
            }
            className={inputClass}
            placeholder={placeholder}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#f2f5fb] text-[#17213a]/45"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="inline-flex items-center gap-2 rounded-xl bg-[#f2f5fb] px-3 py-2 text-xs font-semibold text-[#3478f6]"
      >
        <Plus className="size-3.5" /> {addLabel}
      </button>
    </div>
  );
}

function CourseLessonEditor({
  lessons,
  onChange,
}: {
  lessons: CommerceLesson[];
  onChange: (lessons: CommerceLesson[]) => void;
}) {
  const update = (index: number, patch: Partial<CommerceLesson>) =>
    onChange(
      lessons.map((lesson, lessonIndex) =>
        lessonIndex === index ? { ...lesson, ...patch } : lesson,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= lessons.length) return;
    const next = [...lessons];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {lessons.map((lesson, index) => (
        <article
          key={lesson.id}
          className="rounded-[22px] border border-black/[0.06] bg-[#f7f8fc] p-4"
        >
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 sm:flex">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[#fff3c6] text-xs font-semibold text-[#7b5800]">
              {index + 1}
            </span>
            <input
              required
              value={lesson.title}
              maxLength={180}
              onChange={(event) => update(index, { title: event.target.value })}
              className={inputClass}
              placeholder="Lesson title"
            />
            <div className="col-span-2 flex justify-end gap-1 sm:col-span-1 sm:justify-start">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="inline-flex size-9 items-center justify-center rounded-xl bg-white text-[#17213a]/55 disabled:opacity-25"
                aria-label={`Move lesson ${index + 1} up`}
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === lessons.length - 1}
                className="inline-flex size-9 items-center justify-center rounded-xl bg-white text-[#17213a]/55 disabled:opacity-25"
                aria-label={`Move lesson ${index + 1} down`}
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onChange(lessons.filter((_, lessonIndex) => lessonIndex !== index))}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-[#17213a]/40"
                aria-label={`Remove lesson ${index + 1}`}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <input
                value={lesson.moduleTitle || ""}
                onChange={(event) => update(index, { moduleTitle: event.target.value })}
                className={inputClass}
                placeholder="Module name, e.g. Getting started"
              />
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl bg-white px-4 text-xs font-semibold text-[#17213a]/65">
                <input
                  type="checkbox"
                  checked={Boolean(lesson.isPreview)}
                  onChange={(event) => update(index, { isPreview: event.target.checked })}
                  className="size-4 accent-emerald-600"
                />
                Free preview
              </label>
            </div>
            <input
              value={lesson.summary || ""}
              onChange={(event) => update(index, { summary: event.target.value })}
              className={inputClass}
              placeholder="Short lesson summary"
            />
            <textarea
              value={lesson.body || ""}
              onChange={(event) => update(index, { body: event.target.value, contentType: "text" })}
              className={`${inputClass} min-h-28 resize-y`}
              placeholder="Write the lesson content. You can also add a resource link below."
            />
            <input
              type="url"
              value={lesson.url || ""}
              onChange={(event) => update(index, { url: event.target.value })}
              className={inputClass}
              placeholder="Optional video, file, or resource URL"
            />
          </div>
        </article>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...lessons,
            {
              id: crypto.randomUUID(),
              moduleTitle: "Course",
              title: "",
              summary: "",
              contentType: "text",
              body: "",
            },
          ])
        }
        className="inline-flex items-center gap-2 rounded-xl bg-[#fff3c6] px-3 py-2 text-xs font-semibold text-[#7b5800]"
      >
        <Plus className="size-3.5" /> Add lesson
      </button>
    </div>
  );
}

function ProductAssetUploader({
  files,
  onChange,
}: {
  files: CommerceAsset[];
  onChange: (files: CommerceAsset[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (selected: File[]) => {
    setBusy(true);
    const uploaded: CommerceAsset[] = [];
    try {
      for (const file of selected) {
        const result = await uploadFileResult(file, "product_file");
        uploaded.push({
          id: crypto.randomUUID(),
          key: result.key,
          name: result.name,
          size: result.size,
          mimeType: result.mimeType,
        });
      }
      onChange([...files, ...uploaded]);
      toast.success(
        uploaded.length === 1 ? "Buyer file uploaded" : `${uploaded.length} files uploaded`,
      );
    } catch (error) {
      if (uploaded.length) onChange([...files, ...uploaded]);
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="space-y-2">
        {files.map((file) => (
          <div key={file.id} className="flex items-center gap-3 rounded-2xl bg-[#f2f5fb] px-4 py-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-white text-[#3478f6]">
              <Download className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{file.name}</div>
              <div className="text-[10px] text-[#17213a]/40">
                {Math.max(1, Math.round(Number(file.size || 0) / 1024))} KB · private
              </div>
            </div>
            <button
              type="button"
              onClick={() => onChange(files.filter((candidate) => candidate.id !== file.id))}
              className="text-[#17213a]/35"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="mt-3 inline-flex items-center gap-2 rounded-2xl border border-dashed border-[#3478f6]/35 bg-[#eef5ff] px-4 py-3 text-sm font-semibold text-[#3478f6]"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Add
        files for buyers
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          if (selected.length) void upload(selected);
          e.target.value = "";
        }}
      />
      <p className="mt-2 text-xs text-[#17213a]/42">
        Only customers with a valid purchase link can download these files.
      </p>
    </div>
  );
}
