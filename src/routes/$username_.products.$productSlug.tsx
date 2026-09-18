import { BentoFullLogo } from "@/components/BentoBrand";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowRight,
  BadgePercent,
  Check,
  ExternalLink,
  GraduationCap,
  Loader2,
  LockKeyhole,
  Mail,
  MessagesSquare,
  PackageOpen,
  Radio,
  Repeat2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { DecodedImage } from "@/components/DecodedImage";
import { productWebsite, downloadBenefit, productAccentTextColor } from "@/lib/product-website";
import {
  createCommerceCheckout,
  getCommerceAccess,
  getPublicCommerceProduct,
  previewCommerceCheckout,
  recordCommerceAffiliateClick,
  submitCommerceLead,
} from "@/lib/commerce.functions";
import {
  commerceKind,
  formatCommerceMoney,
  pricingLabel,
  type CommerceFormField,
  type CommerceLesson,
  type CommerceProductKind,
  type CommerceProductRecord,
} from "@/lib/commerce";
import { calculateCommerceCheckoutQuote, type CommerceCheckoutQuote } from "@/lib/commerce-growth";
import { captureProductEvent } from "@/lib/posthog";
import { safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";
import {
  normalizePublicUsername,
  publicProductPath,
  publicProfileUrl,
} from "@/lib/application-urls";
import { readCheckoutRecovery, writeCheckoutRecovery } from "@/lib/checkout-recovery";
import { publicProductHead } from "@/lib/open-graph";
import { browserTimeZone } from "@/lib/timezones";
import {
  requireWebMcpUserConfirmation,
  useWebMcpTools,
  webMcpResult,
  type WebMcpTool,
} from "@/lib/webmcp";

export const Route = createFileRoute("/$username_/products/$productSlug")({
  validateSearch: z.object({
    checkout: z.enum(["canceled"]).optional(),
  }),
  loader: async ({ params, location }) => {
    const data = await getPublicCommerceProduct({
      data: { username: normalizePublicUsername(params.username), publicSlug: params.productSlug },
    });
    if (!data) throw notFound();
    if (data.creator.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicProductPath(data.creator.username, data.product.public_slug)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Product not found | bento.surf" }] };
    const coverUrl = safeMediaUrl(loaderData.product.cover_url);
    return publicProductHead(
      {
        ...loaderData,
        product: {
          ...loaderData.product,
          cover_url: coverUrl && !coverUrl.startsWith("/") ? coverUrl : null,
        },
      },
      import.meta.env.VITE_PUBLIC_URL,
    );
  },
  component: PublicProductPage,
});

const PRODUCT_ICONS: Record<CommerceProductKind, typeof PackageOpen> = {
  digital_product: PackageOpen,
  coaching_call: MessagesSquare,
  course: GraduationCap,
  webinar: Radio,
  paid_community: UsersRound,
  membership: Repeat2,
  custom_product: Wrench,
  priority_dm: Mail,
  bundle: PackageOpen,
  newsletter: Mail,
  lead_form: Mail,
  bento_affiliate: BadgePercent,
};

function PublicProductPage() {
  const data = Route.useLoaderData();
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => setTimeZone(browserTimeZone()), []);
  const { product, creator } = data;
  const website = productWebsite(product.settings?.website);
  const brand = website.brand || creator.display_name || creator.username;
  const definition = commerceKind(product.kind);
  const Icon = PRODUCT_ICONS[product.kind as CommerceProductKind];
  const coverUrl = safeMediaUrl(product.cover_url);
  const lessons = useMemo(() => (Array.isArray(data.lessons) ? data.lessons : []), [data.lessons]);
  const benefits = productBenefits(product, timeZone, data.bundleProducts);
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_public_product",
        title: "Get public Bento product",
        description:
          "Returns the public product, creator, pricing, availability, benefits, lessons, bundle contents, and checkout options visible in this tab.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the public Bento product.", {
            creator: {
              username: creator.username,
              displayName: creator.display_name,
            },
            product: {
              id: product.id,
              slug: product.public_slug,
              kind: product.kind,
              title: product.title,
              subtitle: product.subtitle,
              description: product.description,
              pricingType: product.pricing_type,
              priceAmount: product.price_amount,
              currency: product.currency,
              billingInterval: product.billing_interval,
              inventoryRemaining:
                product.inventory_limit == null
                  ? null
                  : Math.max(0, product.inventory_limit - product.sales_count),
              benefits,
              lessonCount: lessons.length,
              lessons: lessons.slice(0, 100).map((lesson) => ({
                title: lesson.title,
                description: lesson.description,
                preview: Boolean(lesson.preview),
              })),
              bundleProducts: data.bundleProducts,
              availabilityError: data.availabilityError,
              orderBump: data.orderBump,
            },
          }),
      },
    ],
    [benefits, creator, data, lessons, product],
  );
  useWebMcpTools(webMcpTools);

  return (
    <div
      data-product-website
      className="min-h-screen overflow-x-clip pb-24 font-sans text-[#17213a] lg:pb-0"
      style={
        {
          background:
            website.background === "white"
              ? "#ffffff"
              : website.background === "blue"
                ? "#f0f5ff"
                : "#faf8f4",
          "--product-accent": website.accent,
        } as React.CSSProperties
      }
    >
      <header className="border-b border-black/[0.06]">
        <div className="mx-auto flex min-h-20 max-w-7xl items-center justify-between gap-5 px-5 sm:px-10">
          <a
            href={publicProfileUrl(creator.username, null, import.meta.env.VITE_PUBLIC_URL)}
            className="min-w-0 truncate text-lg font-semibold tracking-tight"
          >
            {brand}
          </a>
          <nav
            aria-label="Product navigation"
            className="flex shrink-0 items-center gap-5 text-sm font-medium"
          >
            {benefits.length > 0 && (
              <a className="hidden hover:underline sm:inline" href="#included">
                What's included
              </a>
            )}
            <a
              href="#purchase"
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5"
              style={{
                background: website.accent,
                color: productAccentTextColor(website.accent),
              }}
            >
              {product.pricing_type === "free" ? "Get access" : "Get it now"}
              <ArrowRight className="size-4" />
            </a>
          </nav>
        </div>
      </header>
      <main className="mx-auto grid w-full min-w-0 max-w-7xl gap-10 px-5 py-12 sm:px-10 sm:py-20 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-16">
        <div className="min-w-0">
          <section className={website.layout === "centered" ? "text-center" : "text-left"}>
            <p
              className="mb-5 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ background: website.accent, color: productAccentTextColor(website.accent) }}
            >
              <Icon className="size-4" />
              {definition.label}
            </p>
            <h1
              className={
                (website.font === "serif" ? "font-display" : "font-sans font-semibold") +
                " text-balance text-5xl leading-[1.04] tracking-[-0.055em] sm:text-6xl xl:text-7xl"
              }
            >
              {product.title}
            </h1>
            {product.subtitle && (
              <p className="mt-6 text-xl leading-8 text-[#17213a]/65">{product.subtitle}</p>
            )}
            {coverUrl && (
              <DecodedImage
                src={coverUrl}
                alt={product.title}
                loading="eager"
                className="mt-9 max-h-[540px] w-full rounded-2xl object-cover shadow-[0_24px_70px_-40px_rgba(23,33,58,.5)]"
              />
            )}
            {product.description && (
              <div className="mt-8 whitespace-pre-wrap text-base leading-8 text-[#17213a]/75">
                {product.description}
              </div>
            )}
          </section>

          {benefits.length > 0 && (
            <section id="included" className="mt-12 border-t border-black/10 pt-8">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
                What you get
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {benefits.map((benefit: string) => (
                  <div
                    key={benefit}
                    className="flex min-w-0 items-start gap-3 rounded-xl bg-white/70 px-4 py-4 text-sm leading-6 [overflow-wrap:anywhere]"
                  >
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#dceaff] text-[#3478f6]">
                      <Check className="size-3" />
                    </span>
                    {benefit}
                  </div>
                ))}
              </div>
            </section>
          )}

          {product.kind === "course" && lessons.length > 0 && (
            <section className="mt-5 rounded-2xl border border-black/[0.06] bg-white p-6 shadow-sm sm:p-8">
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-2xl bg-[#fff3c6] text-[#b47800]">
                  <GraduationCap className="size-5" />
                </span>
                <div>
                  <h2 className="font-display text-2xl">Inside the course</h2>
                  <p className="text-xs text-[#17213a]/45">
                    {lessons.length} lessons · private after purchase
                  </p>
                </div>
              </div>
              <div className="mt-5 space-y-2">
                {lessons.map((lesson: CommerceLesson, index: number) => (
                  <div
                    key={lesson.id || index}
                    className="flex items-center gap-3 rounded-2xl border border-black/[0.06] px-4 py-3"
                  >
                    <span className="flex size-8 items-center justify-center rounded-xl bg-[#f2f5fb] text-xs font-semibold text-[#17213a]/45">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 truncate text-sm font-medium">
                      {lesson.title}
                    </div>
                    {lesson.isPreview ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">
                        Preview
                      </span>
                    ) : (
                      <LockKeyhole className="size-3.5 text-[#17213a]/28" />
                    )}
                  </div>
                ))}
              </div>
              {lessons
                .filter((lesson: CommerceLesson) => lesson.isPreview)
                .map((lesson: CommerceLesson) => (
                  <article
                    key={`preview-${lesson.id}`}
                    className="mt-3 rounded-2xl border border-emerald-100 bg-emerald-50/55 p-4"
                  >
                    <div className="text-xs font-semibold text-emerald-800">{lesson.title}</div>
                    {(lesson.body || lesson.summary) && (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#17213a]/60">
                        {lesson.body || lesson.summary}
                      </p>
                    )}
                    {safeNavigationHref(lesson.url) && (
                      <a
                        href={safeNavigationHref(lesson.url)!}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-emerald-800"
                      >
                        Open preview resource <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </article>
                ))}
            </section>
          )}

          {website.sections.map((section) => (
            <section key={section.id} className="mt-12 border-t border-black/10 pt-8">
              {section.title && (
                <h2 className="text-3xl font-semibold tracking-tight">{section.title}</h2>
              )}
              {section.body && (
                <p className="mt-5 whitespace-pre-wrap text-base leading-8 text-[#17213a]/70">
                  {section.body}
                </p>
              )}
              {safeMediaUrl(section.imageUrl) && (
                <DecodedImage
                  src={safeMediaUrl(section.imageUrl)!}
                  alt={section.title}
                  loading="lazy"
                  className="mt-6 max-h-[600px] w-full rounded-2xl object-contain"
                />
              )}
            </section>
          ))}
          <section className="mt-12 rounded-2xl bg-[#17213a] p-6 text-white sm:p-8">
            <div className="grid gap-4 sm:grid-cols-3">
              <TrustPoint
                icon={ShieldCheck}
                title="Secure checkout"
                body="Payment details never touch Bento servers."
              />
              <TrustPoint
                icon={LockKeyhole}
                title="Private access"
                body="Downloads and member content require an active purchase."
              />
              <TrustPoint
                icon={Sparkles}
                title="Creator-owned"
                body={`Made by ${creator.display_name || creator.username}.`}
              />
            </div>
          </section>
        </div>

        <aside id="purchase" className="min-w-0 scroll-mt-8 lg:sticky lg:top-8">
          <PurchaseCard
            product={product}
            accent={website.accent}
            testCheckout={Boolean(data.testCheckout)}
            orderBump={data.orderBump}
            availabilityError={data.availabilityError}
            recordingAddonReady={data.recordingAddonReady}
          />
        </aside>
      </main>
      <a
        href="#purchase"
        className="fixed inset-x-4 bottom-4 z-50 flex items-center justify-between gap-4 rounded-xl px-5 py-4 text-sm font-semibold shadow-2xl lg:hidden"
        style={{ background: website.accent, color: productAccentTextColor(website.accent) }}
      >
        <span>
          {pricingLabel(
            product.pricing_type,
            product.price_amount,
            product.currency,
            product.billing_interval,
          )}
        </span>
        <span className="inline-flex items-center gap-2">
          {product.cta_label} <ArrowRight className="size-4" />
        </span>
      </a>
      <footer className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 border-t border-black/10 px-5 py-8 text-xs text-[#17213a]/55 sm:px-10">
        <span>{brand}</span>
        <a href={publicProfileUrl(creator.username, "store", import.meta.env.VITE_PUBLIC_URL)}>
          More from {brand}
        </a>
        <a href="http://localhost:8080" aria-label="Made with bento.surf">
          <BentoFullLogo className="h-5 w-auto" />
        </a>
      </footer>
    </div>
  );
}

function PurchaseCard({
  product,
  accent,
  testCheckout,
  orderBump,
  availabilityError,
  recordingAddonReady,
}: {
  product: CommerceProductRecord;
  accent: string;
  testCheckout: boolean;
  orderBump: {
    bump_product_id: string;
    headline: string;
    description: string;
    product: {
      id: string;
      title: string;
      price_amount: number;
      currency: string;
    };
  } | null;
  availabilityError: string | null;
  recordingAddonReady: boolean;
}) {
  const { checkout: checkoutState } = Route.useSearch();
  const [ownedToken, setOwnedToken] = useState<string | null>(null);
  useEffect(
    () => setOwnedToken(window.sessionStorage.getItem("bento:product-access:" + product.id)),
    [product.id],
  );
  const ownedAccess = useQuery({
    queryKey: ["owned-product-access", product.id, ownedToken],
    queryFn: () => getCommerceAccess({ data: { token: ownedToken! } }),
    enabled: Boolean(ownedToken),
    retry: false,
  });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [recordingAddon, setRecordingAddon] = useState(false);
  const [bumpProductId, setBumpProductId] = useState<string | undefined>();
  const [discountInput, setDiscountInput] = useState("");
  const [appliedDiscountCode, setAppliedDiscountCode] = useState<string | undefined>();
  const [quote, setQuote] = useState<CommerceCheckoutQuote>(() =>
    calculateCommerceCheckoutQuote({ primaryAmount: product.price_amount }),
  );
  const [completed, setCompleted] = useState<string | null>(null);
  const [restoredCheckout, setRestoredCheckout] = useState(false);
  const quoteRequestRef = useRef(0);
  const fields = useMemo(
    () => (Array.isArray(product.settings?.fields) ? product.settings.fields : []),
    [product.settings],
  );
  const webMcpTools = useMemo(() => {
    const customerProperties = {
      email: {
        type: "string",
        format: "email",
        maxLength: 254,
        description: "Customer email.",
      },
      name: { type: "string", maxLength: 120, description: "Customer name." },
      answers: {
        type: "object",
        description:
          "Answers keyed by product form-field ID; the serialized object must not exceed 50,000 characters.",
        propertyNames: {
          type: "string",
          maxLength: product.kind === "lead_form" ? 100 : 40,
        },
        additionalProperties: { type: "string", maxLength: 5_000 },
        maxProperties: 20,
        "x-maxSerializedLength": 50_000,
      },
      discountCode: {
        type: "string",
        maxLength: 32,
        description: "Optional discount code.",
      },
      bumpProductId: {
        type: "string",
        format: "uuid",
        description: "Optional order-bump product ID.",
      },
      recordingAddon: { type: "boolean", description: "Whether to add the recording option." },
      marketingConsent: {
        type: "boolean",
        description: "Whether the customer explicitly opted into marketing.",
      },
    };
    const applyInputs = (input: Record<string, unknown>) => {
      const nextEmail = typeof input.email === "string" ? input.email.trim() : "";
      const nextName = typeof input.name === "string" ? input.name.trim() : "";
      const nextAnswers =
        input.answers && typeof input.answers === "object" && !Array.isArray(input.answers)
          ? Object.fromEntries(
              Object.entries(input.answers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {};
      const nextDiscount =
        typeof input.discountCode === "string" ? input.discountCode.trim() : undefined;
      const nextBump = typeof input.bumpProductId === "string" ? input.bumpProductId : undefined;
      const nextRecording = input.recordingAddon === true;
      setEmail(nextEmail);
      setName(nextName);
      setAnswers(nextAnswers);
      setDiscountInput(nextDiscount || "");
      setAppliedDiscountCode(nextDiscount);
      setBumpProductId(nextBump);
      setRecordingAddon(nextRecording);
      setMarketingConsent(input.marketingConsent === true);
      return {
        email: nextEmail,
        name: nextName,
        answers: nextAnswers,
        discountCode: nextDiscount,
        bumpProductId: nextBump,
        recordingAddon: nextRecording,
        marketingConsent: input.marketingConsent === true,
      };
    };
    const tools: WebMcpTool[] = [
      {
        name: "bento_prepare_checkout",
        title: "Prepare Bento checkout",
        description:
          "Fills the visible checkout form and calculates the current quote without purchasing or redirecting.",
        inputSchema: {
          type: "object",
          properties: customerProperties,
          required: ["email"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input, { signal }) => {
          signal?.throwIfAborted();
          const next = applyInputs(input);
          signal?.throwIfAborted();
          const nextQuote = await previewCommerceCheckout({
            data: {
              productId: product.id,
              discountCode: next.discountCode,
              bumpProductId: next.bumpProductId,
              recordingAddon: next.recordingAddon,
            },
          });
          signal?.throwIfAborted();
          setQuote(nextQuote);
          signal?.throwIfAborted();
          return webMcpResult("Prepared the checkout for review.", { quote: nextQuote });
        },
      },
    ];

    if (product.kind === "lead_form") {
      tools.push({
        name: "bento_submit_lead_form",
        title: "Submit Bento lead form",
        description:
          "Submits the visible lead form after Bento shows the customer a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: customerProperties,
          required: ["email"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input, { signal }) => {
          signal?.throwIfAborted();
          await requireWebMcpUserConfirmation("Submit this lead form", input);
          signal?.throwIfAborted();
          const next = applyInputs(input);
          signal?.throwIfAborted();
          const result = await submitCommerceLead({
            data: {
              productId: product.id,
              email: next.email,
              name: next.name || undefined,
              answers: next.answers,
              marketingConsent: next.marketingConsent,
              source: document.referrer || undefined,
            },
          });
          signal?.throwIfAborted();
          setCompleted(result.message);
          signal?.throwIfAborted();
          return webMcpResult("Submitted the lead form.", { result });
        },
      });
    } else if (product.kind === "bento_affiliate") {
      tools.push({
        name: "bento_open_affiliate_offer",
        title: "Open affiliate offer",
        description:
          "Records the affiliate click and opens the external offer after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input, { signal }) => {
          signal?.throwIfAborted();
          await requireWebMcpUserConfirmation("Open this external affiliate offer", input);
          signal?.throwIfAborted();
          const result = await recordCommerceAffiliateClick({
            data: { productId: product.id, referrer: document.referrer || undefined },
          });
          signal?.throwIfAborted();
          const destination = safeNavigationHref(result.url);
          if (!destination) throw new Error("Affiliate link returned an invalid destination.");
          signal?.throwIfAborted();
          window.location.assign(destination);
          signal?.throwIfAborted();
          return webMcpResult("Opened the affiliate offer.", { destination });
        },
      });
    } else {
      tools.push({
        name: "bento_start_checkout",
        title: "Start Bento checkout",
        description:
          "Creates the checkout session and opens the payment provider after Bento shows the customer a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            ...customerProperties,
          },
          required: ["email"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input, { signal }) => {
          signal?.throwIfAborted();
          await requireWebMcpUserConfirmation("Start checkout with these details", input);
          signal?.throwIfAborted();
          const next = applyInputs(input);
          signal?.throwIfAborted();
          const result = await createCommerceCheckout({
            data: {
              productId: product.id,
              email: next.email,
              name: next.name || undefined,
              recordingAddon: next.recordingAddon,
              newsletterOptIn: next.marketingConsent,
              discountCode: next.discountCode,
              bumpProductId: next.bumpProductId,
              answers: next.answers,
              attribution: checkoutAttribution(),
            },
          });
          signal?.throwIfAborted();
          const destination = safeNavigationHref(result.url);
          if (!destination) throw new Error("Checkout returned an invalid destination.");
          signal?.throwIfAborted();
          window.location.assign(destination);
          signal?.throwIfAborted();
          return webMcpResult("Started checkout.", { destination, test: result.test });
        },
      });
    }
    return tools;
  }, [product]);
  useWebMcpTools(webMcpTools);
  const quotePreview = useMutation({
    mutationFn: (next: {
      discountCode?: string;
      bumpProductId?: string;
      recordingAddon: boolean;
    }) =>
      previewCommerceCheckout({
        data: {
          productId: product.id,
          discountCode: next.discountCode,
          bumpProductId: next.bumpProductId,
          recordingAddon: next.recordingAddon,
        },
      }),
  });
  const refreshQuote = (
    next: {
      discountCode?: string;
      bumpProductId?: string;
      recordingAddon: boolean;
    },
    options?: {
      applyingCode?: boolean;
      onSuccess?: () => void;
      onError?: () => void;
    },
  ) => {
    const requestId = ++quoteRequestRef.current;
    quotePreview.mutate(next, {
      onSuccess: (nextQuote) => {
        if (requestId !== quoteRequestRef.current) return;
        setQuote(nextQuote);
        if (options?.applyingCode) {
          setAppliedDiscountCode(next.discountCode);
          toast.success("Discount applied");
        }
        options?.onSuccess?.();
      },
      onError: (error) => {
        if (requestId !== quoteRequestRef.current) return;
        options?.onError?.();
        toast.error(error instanceof Error ? error.message : "Price could not be updated");
      },
    });
  };
  useEffect(() => {
    const recovered = readCheckoutRecovery(window.sessionStorage, product.id);
    if (!recovered) return;
    setEmail(recovered.email);
    setName(recovered.name);
    const canRestoreRecording =
      recovered.recordingAddon &&
      recordingAddonReady &&
      product.kind === "coaching_call" &&
      Boolean(product.settings?.recordingAddonEnabled) &&
      Number(product.settings?.recordingAddonPrice || 0) > 0;
    setRecordingAddon(canRestoreRecording);
    setRestoredCheckout(true);
    if (canRestoreRecording) {
      refreshQuote({ recordingAddon: true }, { onError: () => setRecordingAddon(false) });
    }
    // Checkout recovery intentionally runs once for this product in the current tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);
  const checkout = useMutation({
    mutationFn: () =>
      createCommerceCheckout({
        data: {
          productId: product.id,
          email,
          name: name || undefined,
          recordingAddon,
          newsletterOptIn: marketingConsent,
          discountCode: appliedDiscountCode,
          bumpProductId,
          answers,
          attribution: checkoutAttribution(),
        },
      }),
    onSuccess: (result) => {
      captureProductEvent("commerce_checkout_started", {
        product_kind: product.kind,
        test: result.test,
      });
      const destination = safeNavigationHref(result.url);
      if (!destination) {
        toast.error("Checkout returned an invalid destination.");
        return;
      }
      window.location.assign(destination);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Checkout could not start"),
  });
  const lead = useMutation({
    mutationFn: () =>
      submitCommerceLead({
        data: {
          productId: product.id,
          email,
          name: name || undefined,
          answers,
          marketingConsent,
          source: document.referrer || undefined,
        },
      }),
    onSuccess: (result) => {
      setCompleted(result.message);
      captureProductEvent("commerce_lead_submitted", { product_kind: product.kind });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Form could not be submitted"),
  });
  const affiliate = useMutation({
    mutationFn: () =>
      recordCommerceAffiliateClick({
        data: { productId: product.id, referrer: document.referrer || undefined },
      }),
    onSuccess: (result) => {
      captureProductEvent("commerce_affiliate_clicked", { product_kind: product.kind });
      const destination = safeNavigationHref(result.url);
      if (!destination) {
        toast.error("Affiliate link returned an invalid destination.");
        return;
      }
      window.location.assign(destination);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Link could not open"),
  });
  const soldOut = product.inventory_limit && product.sales_count >= product.inventory_limit;
  if (ownedToken && ownedAccess.data?.product?.id === product.id)
    return (
      <div className="rounded-2xl border border-black/10 bg-white p-7">
        <h2 className="text-2xl font-semibold">Your purchase is ready</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          You already have access to this product.
        </p>
        <a
          className="mt-5 flex items-center justify-center rounded-lg bg-[#17213a] px-5 py-3 font-semibold text-white"
          href={
            (import.meta.env.VITE_APP_URL || "http://localhost:8080").replace(/\/$/, "") +
            "/access/" +
            ownedToken
          }
        >
          Open my purchase
        </a>
      </div>
    );
  if (completed)
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-7 text-emerald-900 shadow-[0_28px_80px_-52px_rgba(23,33,58,.65)]">
        <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Check className="size-5" />
        </span>
        <h2 className="mt-5 font-display text-3xl">You're in.</h2>
        <p className="mt-3 text-sm leading-6 text-emerald-800/70">{completed}</p>
      </div>
    );
  return (
    <div className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_28px_80px_-52px_rgba(23,33,58,.65)]">
      {testCheckout && product.pricing_type !== "free" && (
        <div className="border-b border-[#3478f6]/15 bg-[#dceaff] px-6 py-3 text-center text-xs font-semibold text-[#245fd0]">
          Test checkout - no card is requested, no money is charged, and no payout is created.
        </div>
      )}
      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.17em] text-[#17213a]/38">
              {product.pricing_type === "subscription"
                ? "Recurring access"
                : product.pricing_type === "free"
                  ? "No payment"
                  : "One-time purchase"}
            </div>
            <div className="mt-2 font-display text-4xl">
              {pricingLabel(
                quote.grossAmount > 0 && product.pricing_type === "free"
                  ? "one_time"
                  : product.pricing_type,
                quote.grossAmount,
                product.currency,
                product.billing_interval,
              )}
            </div>
          </div>
          {product.inventory_limit && (
            <span className="rounded-full bg-[#fff3c6] px-2.5 py-1 text-[10px] font-semibold text-[#7b5800]">
              {Math.max(0, product.inventory_limit - product.sales_count)} left
            </span>
          )}
        </div>
        {availabilityError && (
          <div
            role="alert"
            className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"
          >
            This offer is temporarily unavailable. Please contact the creator or try again later.
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (product.kind === "lead_form") lead.mutate();
            else if (product.kind === "bento_affiliate") affiliate.mutate();
            else {
              writeCheckoutRecovery(window.sessionStorage, {
                productId: product.id,
                email,
                name,
                recordingAddon,
              });
              checkout.mutate();
            }
          }}
          className="mt-6 space-y-3"
        >
          {(checkoutState === "canceled" || restoredCheckout) && (
            <div
              role="status"
              className="rounded-2xl border border-[#3478f6]/15 bg-[#eef5ff] px-4 py-3 text-xs leading-5 text-[#245fd0]"
            >
              {checkoutState === "canceled"
                ? "Checkout was not completed. Your details are still here when you're ready."
                : "Your checkout details were restored in this tab."}
            </div>
          )}
          {product.kind !== "bento_affiliate" && (
            <>
              <label className="block text-xs font-semibold text-[#17213a]/70">
                Email address
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className={`${inputClass} mt-1.5`}
                />
              </label>
              <label className="block text-xs font-semibold text-[#17213a]/70">
                Name <span className="font-normal text-[#17213a]/50">(optional)</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                  className={`${inputClass} mt-1.5`}
                />
              </label>
              {product.kind !== "lead_form" && (
                <label className="flex items-start gap-3 rounded-lg bg-[#f7f8fc] p-3 text-xs leading-5 text-[#17213a]/70">
                  <input
                    type="checkbox"
                    checked={marketingConsent}
                    onChange={(event) => setMarketingConsent(event.target.checked)}
                    className="mt-1 size-4 shrink-0"
                  />
                  <span>
                    Email me updates and offers from this creator. Optional; access does not depend
                    on subscribing.
                  </span>
                </label>
              )}
            </>
          )}
          {product.kind === "lead_form" &&
            fields
              .filter((field: CommerceFormField) => field.type !== "email" && field.id !== "email")
              .map((field: CommerceFormField) => (
                <input
                  key={field.id}
                  required={Boolean(field.required)}
                  value={answers[field.id] || ""}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                  placeholder={field.label}
                  className={inputClass}
                />
              ))}
          {product.kind === "custom_product" &&
            (product.settings?.buyerQuestions || []).map((question: string, index: number) => (
              <label key={`${index}-${question}`} className="block">
                <span className="mb-2 block text-xs font-semibold text-[#17213a]/65">
                  {question}
                </span>
                <textarea
                  required
                  rows={3}
                  maxLength={5_000}
                  value={answers[`q_${index}`] || ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [`q_${index}`]: event.target.value,
                    }))
                  }
                  placeholder="Your answer"
                  className={`${inputClass} resize-y`}
                />
              </label>
            ))}
          {product.kind === "priority_dm" && (
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-[#17213a]/65">
                {product.settings?.priorityPrompt || "What would you like to ask?"}
              </span>
              <textarea
                required
                rows={5}
                maxLength={5_000}
                value={answers.priority_message || ""}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    priority_message: event.target.value,
                  }))
                }
                placeholder="Write your message"
                className={`${inputClass} resize-y`}
              />
              <span className="mt-2 block text-[11px] leading-4 text-[#17213a]/45">
                The creator will receive this as a paid priority request and can reply by email or
                through Bento.
              </span>
            </label>
          )}
          {product.kind === "lead_form" && (
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-black/[0.07] bg-[#f8faff] p-4">
              <input
                type="checkbox"
                checked={marketingConsent}
                onChange={(event) => setMarketingConsent(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[#3478f6]"
              />
              <span className="text-xs leading-5 text-[#17213a]/58">
                Email me useful updates from this creator. Optional, and I can unsubscribe anytime.
              </span>
            </label>
          )}
          {product.kind === "coaching_call" &&
            recordingAddonReady &&
            product.settings?.recordingAddonEnabled &&
            Number(product.settings.recordingAddonPrice || 0) > 0 && (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-black/[0.12] bg-white p-4">
                <input
                  type="checkbox"
                  checked={recordingAddon}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    const previous = recordingAddon;
                    setRecordingAddon(checked);
                    refreshQuote(
                      {
                        discountCode: appliedDiscountCode,
                        bumpProductId,
                        recordingAddon: checked,
                      },
                      { onError: () => setRecordingAddon(previous) },
                    );
                  }}
                  className="mt-0.5 size-4 accent-[#3478f6]"
                />
                <span>
                  <span className="block text-sm font-semibold">Add the Fathom recording</span>
                  <span className="mt-0.5 block text-xs leading-5 text-[#17213a]/50">
                    Receive a private recording link after the call ·{" "}
                    {formatCommerceMoney(
                      Number(product.settings.recordingAddonPrice),
                      product.currency,
                    )}
                  </span>
                </span>
              </label>
            )}
          {orderBump && product.pricing_type === "one_time" && (
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#f0ad00]/25 bg-[#fff9e8] p-4">
              <input
                type="checkbox"
                checked={bumpProductId === orderBump.product.id}
                onChange={(event) => {
                  const nextBump = event.target.checked ? orderBump.product.id : undefined;
                  const previous = bumpProductId;
                  setBumpProductId(nextBump);
                  refreshQuote(
                    {
                      discountCode: appliedDiscountCode,
                      bumpProductId: nextBump,
                      recordingAddon,
                    },
                    { onError: () => setBumpProductId(previous) },
                  );
                }}
                className="mt-0.5 size-4 accent-[#f0ad00]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{orderBump.headline}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[#17213a]/50">
                  {orderBump.description || orderBump.product.title} ·{" "}
                  {formatCommerceMoney(orderBump.product.price_amount, orderBump.product.currency)}
                </span>
              </span>
            </label>
          )}
          {product.pricing_type === "one_time" && (
            <div className="rounded-2xl border border-black/[0.07] bg-[#f8faff] p-3">
              <label
                htmlFor={`discount-${product.id}`}
                className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/40"
              >
                Discount code
              </label>
              <div className="flex min-w-0 gap-2">
                <input
                  id={`discount-${product.id}`}
                  value={discountInput}
                  onChange={(event) => setDiscountInput(event.target.value.toUpperCase())}
                  placeholder="Enter code"
                  maxLength={32}
                  className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm uppercase outline-none focus:border-[#3478f6]/45"
                />
                <button
                  type="button"
                  disabled={!discountInput.trim() || quotePreview.isPending}
                  onClick={() =>
                    refreshQuote(
                      {
                        discountCode: discountInput,
                        bumpProductId,
                        recordingAddon,
                      },
                      { applyingCode: true },
                    )
                  }
                  className="shrink-0 rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-45"
                >
                  {quotePreview.isPending ? <Loader2 className="size-4 animate-spin" /> : "Apply"}
                </button>
              </div>
              {appliedDiscountCode && quote.discountAmount > 0 && (
                <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-emerald-600">
                    {appliedDiscountCode} applied
                  </span>
                  <button
                    type="button"
                    className="text-[#17213a]/45 underline"
                    onClick={() => {
                      const previousCode = appliedDiscountCode;
                      const previousInput = discountInput;
                      setAppliedDiscountCode(undefined);
                      setDiscountInput("");
                      refreshQuote(
                        { bumpProductId, recordingAddon },
                        {
                          onError: () => {
                            setAppliedDiscountCode(previousCode);
                            setDiscountInput(previousInput);
                          },
                        },
                      );
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}
          {(quote.discountAmount > 0 || quote.bumpAmount > 0 || quote.recordingAddonAmount > 0) && (
            <div className="space-y-2 rounded-2xl border border-black/[0.06] px-4 py-3 text-xs">
              <PriceRow
                label="Subtotal"
                value={formatCommerceMoney(quote.subtotalAmount, product.currency)}
              />
              {quote.discountAmount > 0 && (
                <PriceRow
                  label="Discount"
                  value={`−${formatCommerceMoney(quote.discountAmount, product.currency)}`}
                  positive
                />
              )}
              <div className="border-t border-black/[0.06] pt-2">
                <PriceRow
                  label="Total"
                  value={formatCommerceMoney(quote.grossAmount, product.currency)}
                  strong
                />
              </div>
            </div>
          )}
          <button
            type="submit"
            disabled={
              Boolean(availabilityError) ||
              soldOut ||
              checkout.isPending ||
              lead.isPending ||
              affiliate.isPending ||
              quotePreview.isPending
            }
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold text-white shadow-[0_16px_30px_-20px_rgba(23,33,58,.7)] transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
            style={{
              background: accent,
              color: productAccentTextColor(accent),
            }}
          >
            {checkout.isPending ||
            lead.isPending ||
            affiliate.isPending ||
            quotePreview.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : availabilityError ? (
              "Unavailable"
            ) : soldOut ? (
              "Sold out"
            ) : (
              product.cta_label
            )}
            <ArrowRight className="size-4" />
          </button>
        </form>
        <p className="mt-3 text-center text-[11px] leading-5 text-[#17213a]/38">
          {product.kind === "bento_affiliate"
            ? "Tracked Bento referral link"
            : product.kind === "lead_form"
              ? "Your answers go directly to this creator."
              : product.pricing_type === "free"
                ? "A private access link is created instantly."
                : "Your details carry over to checkout. The payment provider may require a billing address to calculate tax."}
        </p>
      </div>
      {product.pricing_type !== "free" && (
        <div className="border-t border-black/[0.06] bg-[#f7f8fc] px-6 py-4 text-center text-[10px] font-medium text-[#17213a]/38">
          {testCheckout
            ? "Staging uses zero-money mock checkout only."
            : "Payment is processed securely by this creator's connected payment provider."}
        </div>
      )}
    </div>
  );
}

function PriceRow({
  label,
  value,
  positive = false,
  strong = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 ${strong ? "font-semibold" : "text-[#17213a]/55"}`}
    >
      <span>{label}</span>
      <span className={`tabular-nums ${positive ? "text-emerald-600" : ""}`}>{value}</span>
    </div>
  );
}

function checkoutAttribution() {
  const params = new URLSearchParams(window.location.search);
  return {
    referrer: document.referrer || undefined,
    utm_source: params.get("utm_source") || undefined,
    utm_medium: params.get("utm_medium") || undefined,
    utm_campaign: params.get("utm_campaign") || undefined,
    utm_content: params.get("utm_content") || undefined,
  };
}

const inputClass =
  "w-full rounded-lg border border-black/[0.12] bg-white px-4 py-3.5 text-sm outline-none transition placeholder:text-[#17213a]/30 focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10";

function productBenefits(
  product: CommerceProductRecord,
  timeZone: string,
  bundleProducts: Array<{ title: string }> = [],
) {
  const settings = product.settings || {};
  if (settings.benefits?.some((benefit) => benefit.trim()))
    return settings.benefits.filter((benefit) => benefit.trim());
  if (product.kind === "digital_product")
    return (settings.files || []).map((file, index) => downloadBenefit(file.name, index));
  if (product.kind === "coaching_call")
    return [
      `${settings.durationMinutes || 60}-minute session`,
      settings.availabilitySummary || "Choose a time after purchase",
      "Private meeting details",
    ];
  if (product.kind === "course")
    return (settings.lessons || []).map((lesson) => lesson.title).filter(Boolean);
  if (product.kind === "webinar")
    return [
      settings.startsAt
        ? `Live on ${formatWebinarSchedule(settings.startsAt, timeZone)}`
        : "Live online event",
      settings.replayAvailable ? "Replay included" : "Live access",
      "Private attendee link",
    ];
  if (product.kind === "paid_community")
    return ["Private member feed", "Creator updates", "Member conversations"];
  if (product.kind === "membership") return (settings.benefits || []).filter(Boolean);
  if (product.kind === "custom_product")
    return [
      "Personalised fulfilment",
      ...(settings.buyerQuestions || [])
        .slice(0, 2)
        .map((question: string) => `Buyer detail: ${question}`),
    ];
  if (product.kind === "priority_dm")
    return [
      "Paid priority inbox",
      `Reply expected within ${product.settings?.responseTimeHours || 48} hours`,
      `${product.settings?.freeFollowUpLimit ?? 0} included free follow-ups`,
      `Further follow-ups: ${formatCommerceMoney(
        product.settings?.followUpPriceAmount ?? product.price_amount,
        product.currency,
      )}`,
      "Reply delivered by email",
    ];
  if (product.kind === "bundle") return bundleProducts.map((item) => item.title);
  return [];
}

function formatWebinarSchedule(value: string, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "the scheduled date";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(date);
  }
}

function TrustPoint({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}) {
  return (
    <div>
      <span className="flex size-10 items-center justify-center rounded-2xl bg-white/10 text-[#ffc928]">
        <Icon className="size-4" />
      </span>
      <div className="mt-3 text-sm font-semibold">{title}</div>
      <p className="mt-1 text-xs leading-5 text-white/72">{body}</p>
    </div>
  );
}
