import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Cog,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  Plus,
  Settings2,
  Sparkles,
  Star,
  Users,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppPanel, MicroAppTabMotion } from "@/components/MicroAppPanel";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { PriceInput } from "@/components/commerce/PriceInput";
import { BookingReviewCard } from "@/components/bookings/BookingReviewCard";
import { BookingProviderMark } from "@/components/settings/BookingAccountsConnect";
import { SettingsIntegrationsLink } from "@/components/settings/SettingsIntegrationsLink";
import { Switch } from "@/components/ui/switch";
import {
  getBookingWorkspace,
  saveBookingAvailability,
  setBookingReviewVisibility,
  setPublicCalendarPage,
} from "@/lib/booking.functions";
import {
  bookingAvailabilitySettings,
  calendarSetupReadiness,
  type Availability,
  type CalendarSetupStep,
  type WeeklyRule,
} from "@/lib/booking";
import { createCommerceProduct } from "@/lib/commerce.functions";
import { micro } from "@/lib/micro-app-ui";
import { browserTimeZone } from "@/lib/timezones";
import { publicProfilePath, publicProfileUrl } from "@/lib/application-urls";

const bookingSearchSchema = z.object({
  tab: z.enum(["bookings", "sessions", "reviews", "settings"]).catch("bookings"),
  settings: z.enum(["general", "page", "availability", "integrations"]).catch("general"),
});

export const Route = createFileRoute("/_authenticated/calendar")({
  validateSearch: bookingSearchSchema,
  head: () => ({ meta: [{ title: "Calendar bookings | bento.surf" }] }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["booking-workspace"],
      queryFn: () => getBookingWorkspace(),
    });
  },
  component: BookingWorkspace,
});

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type BookingItem = {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  buyer_name: string | null;
  buyer_email: string;
  meeting_url: string | null;
};

type ReviewItem = {
  id: string;
  submitted_at: string | null;
  rating: number | null;
  body: string | null;
  reviewer_name: string | null;
  is_public: boolean;
};

type SessionItem = {
  id: string;
  title: string;
  price_amount: number;
  currency: string;
  status: string;
  slug?: string;
  sales_count?: number;
  settings?: { durationMinutes?: number };
};

type ConnectionItem = {
  id: string;
  email: string | null;
  displayName: string | null;
  isDefault: boolean;
  status: string;
};

type SetupStep =
  | {
      label: string;
      body: string;
      complete: boolean;
      to: "/calendar";
      tab: "sessions" | "settings";
      settings: "general" | "page" | "availability" | "integrations";
    }
  | {
      label: string;
      body: string;
      complete: boolean;
      to: "/settings";
      integration: "bookings";
    };

function BookingWorkspace() {
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const { data, isPending } = useQuery({
    queryKey: ["booking-workspace"],
    queryFn: () => getBookingWorkspace(),
    refetchInterval: 60_000,
  });
  const [availability, setAvailability] = useState<Availability | null>(null);

  useEffect(() => {
    if (data?.availability) {
      setAvailability({ ...data.availability, timezone: browserTimeZone() });
    }
  }, [data?.availability]);

  const save = useMutation({
    mutationFn: () => saveBookingAvailability({ data: availability! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["booking-workspace"] });
      toast.success("Availability saved");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save"),
  });
  const publishCalendar = useMutation({
    mutationFn: (enabled: boolean) => setPublicCalendarPage({ data: { enabled } }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["booking-workspace"] });
      toast.success(result.enabled ? "Calendar page added" : "Calendar page removed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update calendar page"),
  });
  const reviewVisibility = useMutation({
    mutationFn: ({ reviewId, isPublic }: { reviewId: string; isPublic: boolean }) =>
      setBookingReviewVisibility({ data: { reviewId, isPublic } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["booking-workspace"] });
      toast.success("Calendar reviews updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update review"),
  });

  if (isPending || !data || !availability) {
    return (
      <div className={`flex items-center justify-center ${micro.shell}`}>
        <LoaderCircle className="size-8 animate-spin text-[#3478f6]" />
      </div>
    );
  }

  const upcoming = data.bookings.filter(
    (booking: BookingItem) =>
      booking.status === "confirmed" && new Date(booking.ends_at) > new Date(),
  );
  const completed = data.bookings.filter(
    (booking: BookingItem) => new Date(booking.ends_at) <= new Date(),
  );
  const submittedReviews = data.reviews.filter((review: ReviewItem) => review.submitted_at);
  const googleConnected = data.calendarConnections.some(
    (connection: ConnectionItem) => connection.status === "active",
  );
  const setupSteps: SetupStep[] = [
    {
      label: "Connect Google Calendar",
      body: "Avoid conflicts and create Google Meet links automatically.",
      complete: googleConnected,
      to: "/settings",
      integration: "bookings",
    },
    {
      label: "Set your availability",
      body: "Choose the days and hours customers can book.",
      complete: data.availabilityConfigured,
      to: "/calendar",
      tab: "settings",
      settings: "availability",
    },
    {
      label: "Create your first session",
      body: "Add a free or paid call to your Bento page.",
      complete: data.products.length > 0,
      to: "/calendar",
      tab: "sessions",
      settings: "general",
    },
  ];
  const completedSetupSteps = setupSteps.filter((step) => step.complete).length;
  const setup = calendarSetupReadiness({
    locked: data.locked,
    availabilityConfigured: data.availabilityConfigured,
    hasActiveGoogleCalendar: googleConnected,
    sessionCount: data.products.length,
  });

  return (
    <main className={`relative overflow-x-clip ${micro.shell}`}>
      <AppHeader
        title="Calendar"
        actions={
          setup.complete && !data.locked ? (
            <Link
              to="/store"
              search={{ tab: "products", create: "coaching_call", edit: undefined }}
              className={micro.btnPrimaryCompact}
            >
              <Plus className="size-4" /> <span className="hidden sm:inline">New session</span>
            </Link>
          ) : undefined
        }
      />

      <div className={micro.main}>
        {data.locked ? (
          <Panel className="mx-auto mt-8 max-w-3xl text-center">
            <div className={`mx-auto size-14 ${micro.iconWellLavender}`}>
              <CalendarDays className="size-6" />
            </div>
            <h2 className="mt-5 font-ui-display text-3xl">Sell time without calendar ping-pong</h2>
            <p className={`mx-auto mt-2 max-w-lg ${micro.muted}`}>
              Calendar bookings, Google Meet, automated reviews, and optional Fathom recordings are
              included with Store. Existing sessions and bookings remain safe.
            </p>
            <div className="mt-6 flex justify-center">
              <UpgradeDialog feature="calendarBookings" />
            </div>
          </Panel>
        ) : !setup.complete ? (
          <CalendarOnboarding
            step={setup.currentStep}
            availability={availability}
            setAvailability={setAvailability}
            saveAvailability={() => save.mutateAsync()}
            savingAvailability={save.isPending}
            googleReady={data.readiness.google}
            onCompleted={() => queryClient.invalidateQueries({ queryKey: ["booking-workspace"] })}
          />
        ) : (
          <>
            <BookingTabs active={search.tab} />
            <MicroAppTabMotion tabKey={search.tab} className="mt-0">
              {search.tab === "bookings" ? (
                <BookingsHome
                  upcoming={upcoming}
                  completed={completed}
                  reviews={submittedReviews}
                  setupSteps={setupSteps}
                  completedSetupSteps={completedSetupSteps}
                  publicCalendar={data.publicCalendar}
                />
              ) : search.tab === "sessions" ? (
                <SessionsView products={data.products} />
              ) : search.tab === "reviews" ? (
                <ReviewsView
                  reviews={submittedReviews}
                  completedCount={completed.length}
                  pendingReviewId={
                    reviewVisibility.isPending ? reviewVisibility.variables?.reviewId : null
                  }
                  onVisibilityChange={(reviewId, isPublic) =>
                    reviewVisibility.mutate({ reviewId, isPublic })
                  }
                />
              ) : (
                <BookingSettings
                  active={search.settings}
                  availability={availability}
                  setAvailability={setAvailability}
                  save={() => save.mutate()}
                  saving={save.isPending}
                  publicCalendar={data.publicCalendar}
                  onTogglePublicCalendar={(enabled) => publishCalendar.mutate(enabled)}
                  publicCalendarPending={publishCalendar.isPending}
                  calendarConnections={data.calendarConnections}
                  fathomConnections={data.fathomConnections}
                />
              )}
            </MicroAppTabMotion>
          </>
        )}
      </div>
    </main>
  );
}

const SESSION_TEMPLATES = [
  {
    id: "discovery",
    title: "Discovery call",
    description: "A quick, friendly intro call to understand goals and next steps.",
    durationMinutes: 15,
    priceAmount: 0,
    tint: "bg-[#dceaff] text-[#3478f6]",
  },
  {
    id: "ama",
    title: "Ask me anything",
    description: "Focused time for advice, feedback, or answering a specific question.",
    durationMinutes: 30,
    priceAmount: 2500,
    tint: "bg-[#ece7ff] text-[#5b4bc9]",
  },
  {
    id: "coaching",
    title: "Personal coaching",
    description: "A full one-to-one session for deeper guidance and an action plan.",
    durationMinutes: 60,
    priceAmount: 7500,
    tint: "bg-[#fff1d6] text-[#b7790b]",
  },
] as const;

function CalendarOnboarding({
  step,
  availability,
  setAvailability,
  saveAvailability,
  savingAvailability,
  googleReady,
  onCompleted,
}: {
  step: CalendarSetupStep;
  availability: Availability;
  setAvailability: (availability: Availability) => void;
  saveAvailability: () => Promise<unknown>;
  savingAvailability: boolean;
  googleReady: boolean;
  onCompleted: () => Promise<unknown> | void;
}) {
  const [sessionCreationMode, setSessionCreationMode] = useState<"templates" | "custom">(
    "templates",
  );
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>(["discovery"]);
  const [customSession, setCustomSession] = useState({
    title: "",
    description: "",
    durationMinutes: 30,
    pricingType: "free" as "free" | "one_time",
    priceAmount: 0,
  });
  const createSessions = useMutation({
    mutationFn: async () => {
      const chosen = SESSION_TEMPLATES.filter((template) =>
        selectedTemplates.includes(template.id),
      );
      if (!chosen.length) throw new Error("Choose at least one session template.");
      for (const template of chosen) {
        await createCommerceProduct({
          data: {
            product: {
              kind: "coaching_call",
              title: template.title,
              subtitle: `${template.durationMinutes}-minute Google Meet call`,
              description: template.description,
              cover_url: null,
              pricing_type: template.priceAmount === 0 ? "free" : "one_time",
              price_amount: template.priceAmount,
              currency: "usd",
              billing_interval: null,
              cta_label: "Book a call",
              inventory_limit: null,
              settings: {
                durationMinutes: template.durationMinutes,
                location: "google_meet",
                ...bookingAvailabilitySettings(availability),
              },
            },
            addToBento: false,
            pageId: null,
          },
        });
      }
    },
    onSuccess: async () => {
      await onCompleted();
      toast.success("Your Calendar is ready");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not create your sessions"),
  });
  const createCustomSession = useMutation({
    mutationFn: () => {
      const title = customSession.title.trim();
      if (!title) throw new Error("Add a name for your session.");
      if (customSession.pricingType === "one_time" && customSession.priceAmount <= 0) {
        throw new Error("Add a price or make the session free.");
      }

      return createCommerceProduct({
        data: {
          product: {
            kind: "coaching_call",
            title,
            subtitle: `${customSession.durationMinutes}-minute Google Meet call`,
            description:
              customSession.description.trim() ||
              `A ${customSession.durationMinutes}-minute one-to-one Google Meet call.`,
            cover_url: null,
            pricing_type: customSession.pricingType,
            price_amount: customSession.pricingType === "free" ? 0 : customSession.priceAmount,
            currency: "usd",
            billing_interval: null,
            cta_label: "Book a call",
            inventory_limit: null,
            settings: {
              durationMinutes: customSession.durationMinutes,
              location: "google_meet",
              ...bookingAvailabilitySettings(availability),
            },
          },
          addToBento: false,
          pageId: null,
        },
      });
    },
    onSuccess: async () => {
      await onCompleted();
      toast.success("Your custom session is ready");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not create your session"),
  });

  const stepIndex = step === "google" ? 0 : step === "availability" ? 1 : 2;
  const titles = ["Connect your calendar", "When are you available?", "What can people book?"];
  const descriptions = [
    "Bento checks busy times and creates a Google Meet link for every confirmed booking.",
    "Choose your timezone and the hours you want visitors to see. You can fine-tune these later.",
    "Choose a polished template or create a custom session from scratch. You can edit and publish it next.",
  ];

  return (
    <div className="mx-auto max-w-6xl pb-10">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className={micro.eyebrow}>Calendar setup</span>
          <h1 className="mt-1 font-ui-display text-3xl sm:text-4xl">Start taking bookings</h1>
        </div>
        <span className={micro.mutedXs}>Your progress saves automatically</span>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2" aria-label="Calendar setup progress">
        {["Google", "Availability", "Sessions"].map((label, index) => (
          <div key={label}>
            <div
              className={`h-1.5 rounded-full transition-colors ${index <= stepIndex ? "bg-primary" : "bg-border"}`}
            />
            <div
              className={`mt-2 text-[10px] font-semibold sm:text-xs ${index === stepIndex ? "text-foreground" : "text-muted-foreground"}`}
            >
              {index + 1}. {label}
            </div>
          </div>
        ))}
      </div>

      <div className={`grid overflow-hidden ${micro.panel} lg:grid-cols-[1.05fr_.95fr]`}>
        <section className="p-5 sm:p-8 lg:p-10">
          <div className={`size-12 rounded-[18px] ${micro.iconWell}`}>
            {step === "google" ? (
              <CalendarDays className="size-5" />
            ) : step === "availability" ? (
              <Clock3 className="size-5" />
            ) : (
              <Sparkles className="size-5" />
            )}
          </div>
          <h2 className="mt-5 font-ui-display text-3xl sm:text-4xl">{titles[stepIndex]}</h2>
          <p className={`mt-2 max-w-xl ${micro.muted}`}>{descriptions[stepIndex]}</p>

          {step === "google" ? (
            <div className="mt-8">
              <SettingsIntegrationsLink
                integration="bookings"
                className={`${micro.btnPrimary} w-full sm:w-auto`}
                icon={<CalendarDays className="size-4" />}
              >
                Connect Google Calendar
              </SettingsIntegrationsLink>
              {!googleReady && (
                <p className="mt-3 text-xs text-destructive">
                  Google Calendar is not configured for this environment yet.
                </p>
              )}
              <p className={`mt-4 max-w-lg ${micro.mutedXs}`}>
                Bento requests Calendar event access only to check conflicts and create or update
                bookings. Connect and disconnect it from Settings → Integrations.
              </p>
            </div>
          ) : step === "availability" ? (
            <div className="mt-7 space-y-5">
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {DAYS.map((day, dayIndex) => {
                  const rule = availability.weeklyRules.find((item) => item.day === dayIndex);
                  return (
                    <AvailabilityDay
                      key={day}
                      day={day}
                      dayIndex={dayIndex}
                      rule={rule}
                      onChange={(nextRule) =>
                        setAvailability({
                          ...availability,
                          weeklyRules: nextRule
                            ? [
                                ...availability.weeklyRules.filter((item) => item.day !== dayIndex),
                                nextRule,
                              ].sort((a, b) => a.day - b.day)
                            : availability.weeklyRules.filter((item) => item.day !== dayIndex),
                        })
                      }
                    />
                  );
                })}
              </div>
              <button
                type="button"
                disabled={savingAvailability || availability.weeklyRules.length === 0}
                onClick={() => void saveAvailability()}
                className={`${micro.btnPrimary} w-full sm:w-auto`}
              >
                {savingAvailability ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowRight className="size-4" />
                )}
                Save availability
              </button>
            </div>
          ) : (
            <div className="mt-7 space-y-3">
              <div className={`grid grid-cols-2 gap-2 ${micro.soft} rounded-[20px] p-1.5`}>
                <button
                  type="button"
                  onClick={() => setSessionCreationMode("templates")}
                  className={`rounded-2xl px-3 py-2.5 text-xs font-semibold transition ${sessionCreationMode === "templates" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Templates
                </button>
                <button
                  type="button"
                  onClick={() => setSessionCreationMode("custom")}
                  className={`rounded-2xl px-3 py-2.5 text-xs font-semibold transition ${sessionCreationMode === "custom" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Custom session
                </button>
              </div>

              {sessionCreationMode === "templates" ? (
                <>
                  {SESSION_TEMPLATES.map((template) => {
                    const selected = selectedTemplates.includes(template.id);
                    return (
                      <button
                        key={template.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setSelectedTemplates((current) =>
                            selected
                              ? current.filter((id) => id !== template.id)
                              : [...current, template.id],
                          )
                        }
                        className={`flex w-full items-center gap-3 rounded-[20px] border p-3.5 text-left transition ${selected ? "border-[#3478f6] bg-[#3478f6]/5 ring-2 ring-[#3478f6]/10" : "border-black/[0.08] bg-white hover:bg-[#f2f5fb]"}`}
                      >
                        <span
                          className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${template.tint}`}
                        >
                          <Video className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">{template.title}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {template.durationMinutes} min ·{" "}
                            {template.priceAmount ? `$${template.priceAmount / 100}` : "Free"}
                          </span>
                        </span>
                        <span
                          className={`flex size-6 items-center justify-center rounded-full border ${selected ? "border-[#3478f6] bg-[#3478f6] text-white" : "border-black/[0.12]"}`}
                        >
                          {selected && <Check className="size-3.5" />}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    disabled={!selectedTemplates.length || createSessions.isPending}
                    onClick={() => createSessions.mutate()}
                    className={`mt-2 ${micro.btnPrimary} w-full sm:w-auto`}
                  >
                    {createSessions.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    Create {selectedTemplates.length === 1 ? "session" : "sessions"}
                  </button>
                </>
              ) : (
                <div className="space-y-4 rounded-[22px] border border-border/70 bg-background/60 p-4 sm:p-5">
                  <Field label="Session name">
                    <input
                      value={customSession.title}
                      onChange={(event) =>
                        setCustomSession((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      placeholder="Portfolio review"
                      className={inputClass}
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Duration">
                      <select
                        value={customSession.durationMinutes}
                        onChange={(event) =>
                          setCustomSession((current) => ({
                            ...current,
                            durationMinutes: Number(event.target.value),
                          }))
                        }
                        className={inputClass}
                      >
                        {[15, 30, 45, 60, 90, 120].map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {minutes} minutes
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Pricing">
                      <select
                        value={customSession.pricingType}
                        onChange={(event) =>
                          setCustomSession((current) => ({
                            ...current,
                            pricingType: event.target.value as "free" | "one_time",
                            priceAmount: event.target.value === "free" ? 0 : current.priceAmount,
                          }))
                        }
                        className={inputClass}
                      >
                        <option value="free">Free</option>
                        <option value="one_time">Paid</option>
                      </select>
                    </Field>
                  </div>
                  {customSession.pricingType === "one_time" && (
                    <Field label="Price (USD)">
                      <PriceInput
                        amount={customSession.priceAmount}
                        onAmountChange={(priceAmount) =>
                          setCustomSession((current) => ({ ...current, priceAmount }))
                        }
                        className={inputClass}
                      />
                    </Field>
                  )}
                  <Field label="Description (optional)">
                    <textarea
                      value={customSession.description}
                      onChange={(event) =>
                        setCustomSession((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                      placeholder="Tell visitors what they will get from this session."
                      rows={3}
                      className={`${inputClass} resize-none`}
                    />
                  </Field>
                  <button
                    type="button"
                    disabled={
                      !customSession.title.trim() ||
                      (customSession.pricingType === "one_time" &&
                        customSession.priceAmount <= 0) ||
                      createCustomSession.isPending
                    }
                    onClick={() => createCustomSession.mutate()}
                    className={`${micro.btnPrimary} w-full sm:w-auto`}
                  >
                    {createCustomSession.isPending ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    Create custom session
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="border-t border-black/[0.07] bg-[#f2f5fb]/70 p-5 sm:p-8 lg:border-l lg:border-t-0 lg:p-10">
          <div className={micro.eyebrowMuted}>Live preview</div>
          <div className="mt-4 flex min-h-[360px] flex-col rounded-[28px] border border-border/70 bg-background/80 p-5 shadow-sm sm:p-6">
            {step === "google" ? (
              <>
                <div className="flex items-center gap-3">
                  <span className={`size-11 rounded-full ${micro.iconWell}`}>
                    <CalendarDays className="size-5" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">Google Calendar</div>
                    <div className="text-xs text-muted-foreground">Conflicts stay blocked</div>
                  </div>
                </div>
                <div className="mt-auto grid grid-cols-2 gap-2">
                  {["Meet links", "No double-booking", "Timezone-safe", "Easy rescheduling"].map(
                    (item) => (
                      <div
                        key={item}
                        className={`${micro.soft} rounded-2xl p-3 text-xs font-medium`}
                      >
                        <Check className="mb-2 size-4 text-emerald-600" /> {item}
                      </div>
                    ),
                  )}
                </div>
              </>
            ) : step === "availability" ? (
              <>
                <div className="font-ui-display text-2xl">Your week</div>
                <div className="mt-5 space-y-2">
                  {availability.weeklyRules.slice(0, 5).map((rule) => (
                    <div
                      key={rule.day}
                      className={`flex items-center justify-between ${micro.soft} rounded-2xl px-3 py-2.5 text-xs`}
                    >
                      <span className="font-semibold">{DAYS[rule.day]}</span>
                      <span className="text-muted-foreground">
                        {rule.start} – {rule.end}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="font-ui-display text-2xl">Your sessions</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Your session starts as a draft, ready for your finishing touch.
                </p>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  {sessionCreationMode === "templates" ? (
                    SESSION_TEMPLATES.filter((template) =>
                      selectedTemplates.includes(template.id),
                    ).map((template) => (
                      <div
                        key={template.id}
                        className={`flex aspect-square flex-col justify-between rounded-[24px] p-4 ${template.tint}`}
                      >
                        <Video className="size-5" />
                        <div>
                          <div className="text-sm font-semibold leading-tight">
                            {template.title}
                          </div>
                          <div className="mt-1 text-[10px] opacity-65">
                            {template.durationMinutes} minutes
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="col-span-2 flex aspect-[2/1] flex-col justify-between rounded-[24px] bg-[#dceaff] p-4 text-[#3478f6]">
                      <Video className="size-5" />
                      <div>
                        <div className="text-sm font-semibold leading-tight">
                          {customSession.title.trim() || "Your custom session"}
                        </div>
                        <div className="mt-1 text-[10px] opacity-65">
                          {customSession.durationMinutes} minutes ·{" "}
                          {customSession.pricingType === "free"
                            ? "Free"
                            : customSession.priceAmount > 0
                              ? `$${customSession.priceAmount / 100}`
                              : "Add a price"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const BOOKING_TABS = [
  { id: "bookings" as const, label: "Bookings", icon: CalendarDays },
  { id: "sessions" as const, label: "Sessions", icon: Clock3 },
  { id: "reviews" as const, label: "Reviews", icon: Star },
  { id: "settings" as const, label: "Settings", icon: Settings2 },
];

function BookingTabs({ active }: { active: z.infer<typeof bookingSearchSchema>["tab"] }) {
  const navigate = useNavigate();
  return (
    <MicroAppTabs
      tabs={BOOKING_TABS}
      value={active}
      onChange={(tab) => void navigate({ to: "/calendar", search: { tab, settings: "general" } })}
      ariaLabel="Booking section"
      className="mb-7"
    />
  );
}

function BookingsHome({
  upcoming,
  completed,
  reviews,
  setupSteps,
  completedSetupSteps,
  publicCalendar,
}: {
  upcoming: BookingItem[];
  completed: BookingItem[];
  reviews: ReviewItem[];
  setupSteps: SetupStep[];
  completedSetupSteps: number;
  publicCalendar: { enabled: boolean; username: string };
}) {
  return (
    <div className="space-y-5">
      {completedSetupSteps < setupSteps.length && (
        <Panel>
          <div className="grid gap-6 lg:grid-cols-[.72fr_1.28fr] lg:items-center">
            <div>
              <span className="inline-flex rounded-full bg-[#ece7ff] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5b4bc9]">
                {completedSetupSteps} of {setupSteps.length} complete
              </span>
              <h2 className="mt-4 font-ui-display text-3xl">Start taking bookings</h2>
              <p className={`mt-2 max-w-sm ${micro.muted}`}>
                Complete these essentials once. Bento handles availability, Meet links and follow-up
                reviews after that.
              </p>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#f2f5fb]">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${(completedSetupSteps / setupSteps.length) * 100}%` }}
                />
              </div>
            </div>
            <div className="space-y-2">
              {setupSteps.map((step) => (
                <Link
                  key={step.label}
                  to={step.to}
                  search={
                    step.to === "/settings"
                      ? { section: "integrations", integration: step.integration }
                      : { tab: step.tab, settings: step.settings }
                  }
                  className="group flex items-center gap-3 rounded-[20px] border border-border/70 bg-background/65 p-3.5 transition hover:bg-card"
                >
                  <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-full ${step.complete ? "bg-emerald-500 text-white" : "border border-border bg-card"}`}
                  >
                    {step.complete ? (
                      <Check className="size-4" />
                    ) : (
                      <span className="size-2 rounded-full bg-muted-foreground/35" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{step.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{step.body}</span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={CalendarDays} label="Upcoming" value={upcoming.length} />
        <Stat icon={Check} label="Completed" value={completed.length} />
        <Stat icon={Star} label="Reviews" value={reviews.length} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
        <Panel>
          <SectionTitle
            icon={CalendarDays}
            title="Upcoming calls"
            body="Your next confirmed calls, with Meet links ready when it is time."
          />
          <div className="mt-5 divide-y divide-border/70">
            {upcoming.length ? (
              upcoming
                .slice(0, 20)
                .map((booking) => <BookingRow key={booking.id} booking={booking} />)
            ) : (
              <Empty text="No upcoming calls yet. Share a published session to receive bookings." />
            )}
          </div>
        </Panel>
        <div className="space-y-5">
          <Panel>
            <span className={`size-11 ${micro.iconWell}`}>
              <CalendarDays className="size-5" />
            </span>
            <h2 className="mt-4 font-ui-display text-2xl">Your calendar link</h2>
            <p className={`mt-2 ${micro.mutedXs}`}>
              {publicCalendar.enabled
                ? "Share one page where visitors can browse every published session."
                : "This page was removed from your Bento. You can add it back in Page settings."}
            </p>
            {publicCalendar.enabled ? (
              <div className="mt-5">
                <CalendarLinkActions calendar={publicCalendar} />
              </div>
            ) : (
              <div className="mt-5">
                <Link
                  to="/calendar"
                  search={{ tab: "settings", settings: "page" }}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-primary"
                >
                  Page settings <ArrowRight className="size-3.5" />
                </Link>
              </div>
            )}
          </Panel>
          <Panel>
            <span className={`size-11 ${micro.iconWellLavender}`}>
              <Cog className="size-5" />
            </span>
            <h2 className="mt-4 font-ui-display text-2xl">Booking setup</h2>
            <p className={`mt-2 ${micro.mutedXs}`}>
              Update your calendar, recording account or weekly availability without leaving this
              workspace.
            </p>
            <Link
              to="/calendar"
              search={{ tab: "settings", settings: "general" }}
              className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-primary"
            >
              Open settings <ArrowRight className="size-3.5" />
            </Link>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function SessionsView({ products }: { products: SessionItem[] }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className={micro.eyebrowMuted}>Sessions</div>
          <h2 className="mt-1 font-ui-display text-3xl">What can people book?</h2>
          <p className={`mt-1 ${micro.muted}`}>
            Manage duration, pricing and visibility for each call.
          </p>
        </div>
        <Link
          to="/store"
          search={{ tab: "products", create: "coaching_call", edit: undefined }}
          className={micro.btnPrimaryCompact}
        >
          <Plus className="size-4" /> New session
        </Link>
      </div>
      {products.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <Link
              key={product.id}
              to="/store"
              search={{ tab: "products", create: undefined, edit: product.id }}
              className={`group ${micro.card} p-5 transition hover:-translate-y-0.5`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className={`size-12 rounded-[18px] ${micro.iconWell}`}>
                  <Video className="size-5" />
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${product.status === "published" ? "bg-emerald-500/10 text-emerald-700" : "bg-[#f2f5fb] text-[#17213a]/55"}`}
                >
                  {product.status}
                </span>
              </div>
              <h3 className="mt-5 font-ui-display text-2xl">{product.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {product.settings?.durationMinutes || 60} minutes ·{" "}
                {formatMoney(product.price_amount, product.currency)}
              </p>
              <div className="mt-6 flex items-center justify-between border-t border-border/70 pt-4 text-xs">
                <span className="text-muted-foreground">{product.sales_count || 0} booked</span>
                <span className="inline-flex items-center gap-1 font-semibold text-primary">
                  Edit <ChevronRight className="size-3.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Panel className="py-16 text-center">
          <span className={`mx-auto size-14 rounded-[20px] ${micro.iconWell}`}>
            <Video className="size-6" />
          </span>
          <h3 className="mt-5 font-ui-display text-3xl">Create your first session</h3>
          <p className={`mx-auto mt-2 max-w-md ${micro.muted}`}>
            Offer a discovery call, consultation, coaching session or any other bookable time.
          </p>
          <Link
            to="/store"
            search={{ tab: "products", create: "coaching_call", edit: undefined }}
            className={`mt-6 ${micro.btnPrimaryCompact}`}
          >
            <Plus className="size-4" /> New session
          </Link>
        </Panel>
      )}
    </div>
  );
}

function ReviewsView({
  reviews,
  completedCount,
  pendingReviewId,
  onVisibilityChange,
}: {
  reviews: ReviewItem[];
  completedCount: number;
  pendingReviewId: string | null;
  onVisibilityChange: (reviewId: string, isPublic: boolean) => void;
}) {
  const ratings = reviews.map((review) => Number(review.rating || 0)).filter(Boolean);
  const average = ratings.length
    ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
    : 0;

  return (
    <div className="space-y-5">
      <div>
        <div className={micro.eyebrowMuted}>Customer feedback</div>
        <h2 className="mt-1 font-ui-display text-3xl">Reviews after every call</h2>
        <p className={`mt-1 ${micro.muted}`}>
          Bento requests a rating after completed sessions and keeps responses here.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={Star} label="Average rating" value={Number(average.toFixed(1))} />
        <Stat icon={Users} label="Responses" value={reviews.length} />
        <Stat icon={Check} label="Completed calls" value={completedCount} />
      </div>
      <Panel>
        <SectionTitle
          icon={Users}
          title="Customer responses"
          body="Choose which reviews appear on your public calendar. Newest reviews appear first."
        />
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {reviews.length ? (
            reviews.map((review) => (
              <BookingReviewCard
                key={review.id}
                review={{
                  rating: review.rating,
                  body: review.body,
                  reviewerName: review.reviewer_name,
                }}
                visibility={{
                  isPublic: review.is_public,
                  pending: pendingReviewId === review.id,
                  onChange: (isPublic) => onVisibilityChange(review.id, isPublic),
                }}
              />
            ))
          ) : (
            <div className="md:col-span-2">
              <Empty text="Reviews will appear after customers complete a call and respond to the follow-up email." />
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

type BookingSettingsProps = {
  active: z.infer<typeof bookingSearchSchema>["settings"];
  availability: Availability;
  setAvailability: (availability: Availability) => void;
  save: () => void;
  saving: boolean;
  publicCalendar: { enabled: boolean; username: string };
  onTogglePublicCalendar: (enabled: boolean) => void;
  publicCalendarPending: boolean;
  calendarConnections: ConnectionItem[];
  fathomConnections: ConnectionItem[];
};

const SETTINGS_NAV = [
  { id: "general" as const, label: "General", body: "Notice and booking rules", icon: Settings2 },
  {
    id: "page" as const,
    label: "Calendar page",
    body: "Show or remove your booking page",
    icon: CalendarDays,
  },
  {
    id: "availability" as const,
    label: "Availability",
    body: "Weekly working hours",
    icon: Clock3,
  },
  {
    id: "integrations" as const,
    label: "Calendar & recording",
    body: "Google Meet and Fathom",
    icon: Video,
  },
];

function BookingSettings(props: BookingSettingsProps) {
  const { active, availability, setAvailability, save, saving } = props;
  const navigate = useNavigate();

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <div className="lg:hidden">
        <MicroAppTabs
          tabs={SETTINGS_NAV}
          value={active}
          onChange={(settings) =>
            void navigate({ to: "/calendar", search: { tab: "settings", settings } })
          }
          ariaLabel="Booking settings section"
        />
      </div>
      <aside className="hidden overflow-x-auto rounded-[28px] border border-black/[0.07] bg-white p-2 shadow-sm lg:sticky lg:top-24 lg:block lg:self-start">
        <div className="flex min-w-max gap-1 lg:min-w-0 lg:flex-col">
          {SETTINGS_NAV.map(({ id, label, body, icon: Icon }) => (
            <Link
              key={id}
              to="/calendar"
              search={{ tab: "settings", settings: id }}
              className={`flex items-center gap-3 rounded-[20px] px-3 py-3 text-left transition lg:w-full ${active === id ? "bg-[#17213a] text-white" : "hover:bg-[#f2f5fb]"}`}
            >
              <Icon className="size-4 shrink-0" />
              <span>
                <span className="block text-xs font-semibold">{label}</span>
                <span
                  className={`mt-0.5 hidden text-[10px] lg:block ${active === id ? "text-white/65" : "text-[#17213a]/55"}`}
                >
                  {body}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </aside>

      <div>
        {active === "general" ? (
          <Panel>
            <SectionTitle
              icon={Settings2}
              title="General booking rules"
              body="The defaults Bento uses for every session unless you override them."
            />
            <div className="mt-6 grid max-w-2xl gap-5 sm:grid-cols-2">
              <Field label="Minimum notice">
                <NumberInput
                  value={availability.minimumNoticeMinutes / 60}
                  suffix="hours"
                  onChange={(value) =>
                    setAvailability({
                      ...availability,
                      minimumNoticeMinutes: Math.round(value * 60),
                    })
                  }
                />
              </Field>
              <Field label="Booking window">
                <NumberInput
                  value={availability.maximumDaysAhead}
                  suffix="days ahead"
                  onChange={(value) =>
                    setAvailability({ ...availability, maximumDaysAhead: Math.round(value) })
                  }
                />
              </Field>
              <Field label="Start times">
                <NumberInput
                  value={availability.slotIntervalMinutes}
                  suffix="minutes apart"
                  onChange={(value) =>
                    setAvailability({ ...availability, slotIntervalMinutes: value })
                  }
                />
              </Field>
              <Field label="Before each call">
                <NumberInput
                  value={availability.bufferBeforeMinutes}
                  suffix="minutes"
                  onChange={(value) =>
                    setAvailability({ ...availability, bufferBeforeMinutes: value })
                  }
                />
              </Field>
              <Field label="After each call">
                <NumberInput
                  value={availability.bufferAfterMinutes}
                  suffix="minutes"
                  onChange={(value) =>
                    setAvailability({ ...availability, bufferAfterMinutes: value })
                  }
                />
              </Field>
            </div>
            <SaveButton onClick={save} pending={saving} />
          </Panel>
        ) : active === "page" ? (
          <PublicCalendarSettings
            calendar={props.publicCalendar}
            pending={props.publicCalendarPending}
            onToggle={props.onTogglePublicCalendar}
          />
        ) : active === "availability" ? (
          <Panel>
            <SectionTitle
              icon={Clock3}
              title="Weekly availability"
              body="Customers see these hours in their local time."
            />
            <div className="mt-6 max-w-3xl space-y-2">
              {DAYS.map((day, index) => (
                <AvailabilityDay
                  key={day}
                  day={day}
                  dayIndex={index}
                  rule={availability.weeklyRules.find((rule) => rule.day === index)}
                  onChange={(rule) =>
                    setAvailability({
                      ...availability,
                      weeklyRules: [
                        ...availability.weeklyRules.filter((current) => current.day !== index),
                        ...(rule ? [rule] : []),
                      ].sort((left, right) => left.day - right.day),
                    })
                  }
                />
              ))}
            </div>
            <SaveButton onClick={save} pending={saving} />
          </Panel>
        ) : (
          <Panel>
            <SectionTitle
              icon={Video}
              title="Calendar & recording"
              body="Connect Google Calendar and Fathom in Settings. Choose the default account there too."
            />
            <div className="mt-6 max-w-3xl space-y-3">
              <ConnectionStatusCard
                provider="google"
                title="Google Calendar + Meet"
                connections={props.calendarConnections}
              />
              <ConnectionStatusCard
                provider="fathom"
                title="Fathom recordings"
                connections={props.fathomConnections}
              />
              <SettingsIntegrationsLink integration="bookings">
                Manage connections
              </SettingsIntegrationsLink>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function PublicCalendarSettings({
  calendar,
  pending,
  onToggle,
}: {
  calendar: { enabled: boolean; username: string };
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <Panel>
        <SectionTitle
          icon={CalendarDays}
          title="Your calendar page"
          body="Bento adds this page automatically when you complete Bookings setup."
        />
        <div className={`mt-6 max-w-3xl ${micro.soft} border border-black/[0.06] p-4 sm:p-5`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">
                {calendar.enabled ? "Calendar page is added" : "Calendar page is removed"}
              </div>
              <p className={`mt-1 max-w-lg ${micro.mutedXs}`}>
                {calendar.enabled
                  ? "Visitors can browse your published sessions from this page."
                  : "Turn this on to add Calendar back to your Bento pages."}
              </p>
            </div>
            <div className="inline-flex shrink-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-xs font-semibold text-foreground">
              {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              <Switch
                checked={calendar.enabled}
                disabled={pending}
                onCheckedChange={onToggle}
                aria-label="Show calendar page"
              />
              {calendar.enabled ? "On" : "Off"}
            </div>
          </div>
        </div>
        <div
          className={`mt-3 flex max-w-3xl flex-col gap-3 ${micro.soft} border border-black/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between`}
        >
          <div>
            <div className="text-sm font-semibold">Latest reviews</div>
            <p className={`mt-1 ${micro.mutedXs}`}>
              Pick the customer reviews visitors can see below your sessions.
            </p>
          </div>
          <Link
            to="/calendar"
            search={{ tab: "reviews", settings: "general" }}
            className="inline-flex shrink-0 items-center gap-2 text-xs font-semibold text-primary"
          >
            Choose reviews <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </Panel>

      <Panel>
        <SectionTitle
          icon={Link2}
          title="Share calendar link"
          body="Use this in your bio, messages, emails, or anywhere people discover you."
        />
        <div className="mt-6 max-w-3xl">
          <CalendarLinkActions calendar={calendar} showUrl />
        </div>
        <p className={`mt-3 ${micro.mutedXs}`}>
          Session cards on your Bento page still work independently. This page is a second way for
          people to find and book all your calls.
        </p>
      </Panel>
    </div>
  );
}

function calendarPageDetails(username: string) {
  const path = publicProfilePath(username, "calendar");
  return {
    path,
    url: publicProfileUrl(username, "calendar", import.meta.env.VITE_PUBLIC_URL),
  };
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is not supported in this browser.");
}

function CalendarLinkActions({
  calendar,
  showUrl = false,
}: {
  calendar: { enabled: boolean; username: string };
  showUrl?: boolean;
}) {
  const { path, url } = calendarPageDetails(calendar.username);
  const copy = async () => {
    try {
      await copyText(url);
      toast.success("Calendar link copied");
    } catch {
      toast.error("Could not copy the link");
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${micro.soft} border border-black/[0.06] p-2 sm:flex-row`}>
      {showUrl ? (
        <div className="min-w-0 flex-1 truncate px-3 py-2.5 text-sm text-muted-foreground">
          {url}
        </div>
      ) : null}
      <div className={`flex gap-2 ${showUrl ? "" : "w-full"}`}>
        <button
          type="button"
          disabled={!calendar.enabled || !calendar.username}
          onClick={() => void copy()}
          className={`${micro.btnOutline} flex-1 sm:flex-none`}
        >
          <Copy className="size-4" /> Copy link
        </button>
        {calendar.enabled ? (
          <a
            href={path}
            target="_blank"
            rel="noreferrer"
            className={`${micro.btnPrimaryCompact} flex-1 sm:flex-none`}
          >
            Visitor page <ExternalLink className="size-4" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function SaveButton({ onClick, pending }: { onClick: () => void; pending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={`mt-6 ${micro.btnPrimary} w-full sm:w-auto`}
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}{" "}
      Save changes
    </button>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <MicroAppPanel className={className}>{children}</MicroAppPanel>;
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <Panel className="flex items-center gap-4">
      <span className={`size-12 text-xl ${micro.iconWell}`}>
        <Icon className="size-5" />
      </span>
      <div>
        <div className="font-ui-display text-3xl leading-none">{value}</div>
        <div className={`mt-1 ${micro.mutedXs}`}>{label}</div>
      </div>
    </Panel>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof CalendarDays;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className={`size-11 shrink-0 ${micro.iconWell}`}>
        <Icon className="size-5" />
      </span>
      <div>
        <h2 className="font-ui-display text-2xl">{title}</h2>
        <p className={`mt-1 ${micro.mutedXs}`}>{body}</p>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-2xl border border-border bg-background/70 px-3.5 py-3 text-sm outline-none focus:ring-4 focus:ring-primary/10";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={`mb-1.5 block ${micro.eyebrowMuted}`}>{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  suffix,
  onChange,
}: {
  value: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center rounded-2xl border border-border bg-background/70 px-3">
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value.replace(/[^0-9.]/g, ""));
          if (Number.isFinite(next)) onChange(next);
        }}
        className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none"
      />
      <span className="text-[10px] text-muted-foreground">{suffix}</span>
    </div>
  );
}

function AvailabilityDay({
  day,
  dayIndex,
  rule,
  onChange,
}: {
  day: string;
  dayIndex: number;
  rule?: WeeklyRule;
  onChange: (rule: WeeklyRule | null) => void;
}) {
  return (
    <div
      className={`grid grid-cols-[1fr_auto] items-center gap-3 ${micro.soft} rounded-2xl p-3 sm:grid-cols-[130px_1fr]`}
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={Boolean(rule)}
          onChange={(event) =>
            onChange(event.target.checked ? { day: dayIndex, start: "09:00", end: "17:00" } : null)
          }
          className="size-4 accent-primary"
        />
        {day}
      </label>
      {rule ? (
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={rule.start}
            onChange={(event) => onChange({ ...rule, start: event.target.value })}
            className="min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="time"
            value={rule.end}
            onChange={(event) => onChange({ ...rule, end: event.target.value })}
            className="min-w-0 rounded-xl border border-border bg-background px-2 py-2 text-xs"
          />
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Unavailable</span>
      )}
    </div>
  );
}

function ConnectionStatusCard({
  provider,
  title,
  connections,
}: {
  provider: "google" | "fathom";
  title: string;
  connections: ConnectionItem[];
}) {
  const activeConnections = connections.filter((connection) => connection.status === "active");
  const primary =
    activeConnections.find((connection) => connection.isDefault) || activeConnections[0];
  return (
    <div className="rounded-xl border border-black/[0.07] bg-white p-4">
      <div className="flex items-center gap-4">
        <BookingProviderMark provider={provider} connected={activeConnections.length > 0} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {primary
              ? `${primary.displayName || primary.email || "Connected account"}${activeConnections.length > 1 ? ` +${activeConnections.length - 1} more` : ""}`
              : "Not connected"}
          </div>
        </div>
      </div>
    </div>
  );
}

function BookingRow({ booking }: { booking: BookingItem }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <span className={`size-11 shrink-0 ${micro.iconWell}`}>
        <CalendarDays className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{booking.buyer_name || booking.buyer_email}</div>
        <time suppressHydrationWarning className="mt-1 text-xs text-muted-foreground">
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(booking.starts_at))}
        </time>
      </div>
      {booking.meeting_url && (
        <a
          href={booking.meeting_url}
          target="_blank"
          rel="noreferrer"
          className={`${micro.btnSoft} rounded-xl px-3 py-2 text-xs`}
        >
          Open Meet <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className={micro.empty}>
      <p className={micro.muted}>{text}</p>
    </div>
  );
}

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(Number(amount || 0) / 100);
}
