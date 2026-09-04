import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  CalendarDays,
  CalendarX2,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  EyeOff,
  FileText,
  GraduationCap,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Link2,
  PlayCircle,
  Radio,
  Send,
  ShieldCheck,
  ShoppingBag,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import { publicProfileUrl } from "@/lib/application-urls";
import { DecodedImage } from "@/components/DecodedImage";
import { FontApplier } from "@/components/FontApplier";
import {
  cancelCommerceBooking,
  createCommerceBooking,
  createCommerceCommunityComment,
  createCommerceCommunityPost,
  getCommerceAccess,
  markCommerceCommunityNotificationsRead,
  moderateCommerceCommunityContent,
  saveCommerceCommunityPreferences,
  setCommerceCourseLessonProgress,
} from "@/lib/commerce.functions";
import {
  commerceKind,
  type CommerceAsset,
  type CommerceLesson,
  type CommerceProductKind,
  type CommerceProductRecord,
} from "@/lib/commerce";
import { safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";
import { getAvailableCommerceBookingSlots } from "@/lib/booking.functions";
import { browserTimeZone } from "@/lib/timezones";
import { BentoBrand } from "@/components/BentoBrand";
import {
  canOpenWebinarJoinLink,
  canOpenWebinarReplay,
  webinarAccessState,
  type WebinarRegistrationRecord,
} from "@/lib/webinar";
import { requireWebMcpUserConfirmation, useWebMcpTools, webMcpResult } from "@/lib/webmcp";

type CommerceBookingRecord = {
  id: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  meeting_url: string | null;
  recording_status?: string;
  recording_share_url?: string | null;
  status: string;
};

type CommerceCommunityPostRecord = {
  id: string;
  author_kind: "creator" | "member";
  author_name: string;
  body: string;
  is_pinned: boolean;
  resources?: Array<{ label: string; url: string }>;
  moderation_status?: "published" | "hidden" | "removed";
  created_at: string;
};

type CommerceCommunityCommentRecord = {
  id: string;
  post_id: string;
  author_kind: "creator" | "member";
  author_name: string;
  body: string;
  moderation_status?: "published" | "hidden" | "removed";
  created_at: string;
};

type CommerceCommunityNotificationRecord = {
  id: string;
  post_id: string | null;
  comment_id: string | null;
  kind: "creator_post" | "comment" | "reply" | "moderation";
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
};

type CommerceAccessData = {
  product: CommerceProductRecord;
  creator: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    primary_font: string | null;
    secondary_font: string | null;
  };
  grant: {
    id: string;
    buyer_email: string;
    member_name?: string | null;
    community_role?: "member" | "moderator";
    community_notifications_enabled?: boolean;
  };
  bookings: CommerceBookingRecord[];
  posts: CommerceCommunityPostRecord[];
  comments: CommerceCommunityCommentRecord[];
  communityNotifications: CommerceCommunityNotificationRecord[];
  webinarRegistration: WebinarRegistrationRecord | null;
  lessons: CommerceLesson[];
  bundleProducts: Array<{
    product: CommerceProductRecord;
    lessons: CommerceLesson[];
  }>;
  progress: Array<{ lesson_id: string; completed_at: string }>;
  subscription: CommerceSubscriptionAccessRecord | null;
  serverNow: string;
};

type CommerceSubscriptionAccessRecord = {
  status: "active" | "cancel_at_period_end" | "past_due" | "expired" | "revoked";
  current_period_start: string | null;
  current_period_end: string | null;
  grace_expires_at: string | null;
  cancel_at_period_end: boolean;
};

function safeWebMcpText(value: unknown, maxLength = 2_000) {
  if (typeof value !== "string") return null;
  return value
    .replace(/\b(?:sk|pk|whsec|rk)_(?:live|test)_[A-Za-z0-9_-]+\b/gi, "[secret redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/https?:\/\/\S+/gi, "[private URL redacted]")
    .replace(/\/(?:access|review)\/\S+/gi, "/[private path redacted]")
    .replace(/\/api\/commerce\/download\/\S+/gi, "/[private download redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[secret redacted]")
    .trim()
    .slice(0, maxLength);
}

function safeWebMcpLesson(
  lesson: CommerceLesson,
  completedLessonIds: ReadonlySet<string> = new Set(),
) {
  return {
    id: lesson.id,
    moduleTitle: safeWebMcpText(lesson.moduleTitle, 200),
    position: lesson.position ?? null,
    title: safeWebMcpText(lesson.title, 300),
    summary: safeWebMcpText(lesson.summary, 1_000),
    body: safeWebMcpText(lesson.body, 8_000),
    contentType: lesson.contentType ?? "text",
    resourceAvailable: Boolean(safeNavigationHref(lesson.url)),
    completed: completedLessonIds.has(lesson.id),
  };
}

function safeWebMcpBooking(booking: CommerceBookingRecord) {
  return {
    id: booking.id,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    timezone: booking.timezone,
    status: booking.status,
    meetingAvailable: Boolean(safeNavigationHref(booking.meeting_url)),
    recordingStatus: booking.recording_status ?? null,
    recordingAvailable: Boolean(safeNavigationHref(booking.recording_share_url)),
  };
}

// eslint-disable-next-line react-refresh/only-export-components
export function commerceAccessWebMcpSnapshot(data: CommerceAccessData, now = new Date()) {
  const completedLessonIds = new Set(data.progress.map((item) => item.lesson_id));
  const files = Array.isArray(data.product.settings?.files) ? data.product.settings.files : [];
  const webinar = data.webinarRegistration;

  return {
    product: {
      kind: data.product.kind,
      title: safeWebMcpText(data.product.title, 300),
      subtitle: safeWebMcpText(data.product.subtitle, 500),
      description: safeWebMcpText(data.product.description, 4_000),
      creator: {
        username: data.creator.username,
        displayName: safeWebMcpText(data.creator.display_name, 200),
      },
    },
    access: data.subscription
      ? {
          status: data.subscription.status,
          currentPeriodStart: data.subscription.current_period_start,
          currentPeriodEnd: data.subscription.current_period_end,
          graceExpiresAt: data.subscription.grace_expires_at,
          cancelAtPeriodEnd: data.subscription.cancel_at_period_end,
        }
      : { status: "active" },
    downloads: {
      available: files.length > 0,
      files: files.slice(0, 100).map((file) => ({
        id: file.id,
        name: safeWebMcpText(file.name, 300),
        size: Number(file.size || 0),
        mimeType: file.mimeType,
      })),
    },
    course:
      data.product.kind === "course"
        ? {
            completedCount: data.lessons.filter((lesson) => completedLessonIds.has(lesson.id))
              .length,
            lessonCount: data.lessons.length,
            lessons: data.lessons
              .slice(0, 100)
              .map((lesson) => safeWebMcpLesson(lesson, completedLessonIds)),
          }
        : null,
    bundle:
      data.product.kind === "bundle"
        ? data.bundleProducts.slice(0, 50).map(({ product, lessons }) => {
            const bundleFiles = Array.isArray(product.settings?.files)
              ? product.settings.files
              : [];
            return {
              id: product.id,
              kind: product.kind,
              title: safeWebMcpText(product.title, 300),
              downloads: bundleFiles.slice(0, 100).map((file) => ({
                id: file.id,
                name: safeWebMcpText(file.name, 300),
                size: Number(file.size || 0),
                mimeType: file.mimeType,
              })),
              lessons: lessons.slice(0, 100).map((lesson) => safeWebMcpLesson(lesson)),
              fulfillmentInstructions: safeWebMcpText(
                product.settings?.fulfillmentInstructions,
                2_000,
              ),
            };
          })
        : null,
    bookings: data.bookings.slice(0, 100).map(safeWebMcpBooking),
    community:
      data.product.kind === "paid_community" || data.product.kind === "membership"
        ? {
            role: data.grant.community_role ?? "member",
            displayName: safeWebMcpText(data.grant.member_name, 120),
            notificationsEnabled: data.grant.community_notifications_enabled !== false,
            memberPostsAllowed: data.product.settings?.allowMemberPosts !== false,
            posts: data.posts.slice(0, 50).map((post) => ({
              id: post.id,
              authorKind: post.author_kind,
              authorName: safeWebMcpText(post.author_name, 120),
              body: safeWebMcpText(post.body, 5_000),
              pinned: post.is_pinned,
              createdAt: post.created_at,
              resources: (post.resources || []).slice(0, 20).map((resource) => ({
                label: safeWebMcpText(resource.label, 200),
                available: Boolean(safeNavigationHref(resource.url)),
              })),
            })),
            comments: data.comments.slice(0, 100).map((comment) => ({
              id: comment.id,
              postId: comment.post_id,
              authorKind: comment.author_kind,
              authorName: safeWebMcpText(comment.author_name, 120),
              body: safeWebMcpText(comment.body, 3_000),
              createdAt: comment.created_at,
            })),
            notifications: data.communityNotifications.slice(0, 30).map((notification) => ({
              id: notification.id,
              postId: notification.post_id,
              commentId: notification.comment_id,
              kind: notification.kind,
              title: safeWebMcpText(notification.title, 300),
              body: safeWebMcpText(notification.body, 1_000),
              read: notification.is_read,
              createdAt: notification.created_at,
            })),
          }
        : null,
    webinar: webinar
      ? {
          status: webinar.status,
          startsAt: webinar.starts_at,
          endsAt: webinar.ends_at,
          accessState: webinarAccessState(webinar, now),
          joinAvailable: canOpenWebinarJoinLink(webinar, now),
          replayAvailable: canOpenWebinarReplay(webinar, now),
        }
      : null,
    fulfillmentInstructions:
      data.product.kind === "custom_product"
        ? safeWebMcpText(data.product.settings?.fulfillmentInstructions, 2_000)
        : null,
  };
}

// eslint-disable-next-line react-refresh/only-export-components
export function commerceAccessWebMcpTools(data: CommerceAccessData, now: Date) {
  return [
    {
      name: "bento_get_customer_portal",
      title: "Get customer portal",
      description:
        "Returns bounded product, course, progress, booking, community, webinar, and download availability visible in this private customer portal. Private URLs and contact details are omitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () =>
        webMcpResult(
          "Loaded the private customer portal without private resource URLs or contact details.",
          commerceAccessWebMcpSnapshot(data, now),
        ),
    },
  ];
}

export const Route = createFileRoute("/access/$token")({
  head: () => ({
    meta: [
      { title: "Private access | bento.surf" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loader: ({ params }) => getCommerceAccess({ data: { token: params.token } }),
  component: CommerceAccessPage,
});

function CommerceAccessPage() {
  const initial = Route.useLoaderData() as CommerceAccessData | null;
  const { token } = Route.useParams();
  const [data, setData] = useState<CommerceAccessData | null>(initial);
  const now = useLiveNow(initial?.serverNow || "1970-01-01T00:00:00.000Z");
  const webMcpTools = useMemo(
    () => (data ? commerceAccessWebMcpTools(data, now) : []),
    [data, now],
  );
  useWebMcpTools(webMcpTools);

  if (!data) return <InvalidAccess />;
  const { product, creator, grant } = data;
  const definition = commerceKind(product.kind as CommerceProductKind);
  const accessState = subscriptionAccessPresentation(data.subscription);
  return (
    <div className="min-h-screen bg-[#f7f8fc] text-[#17213a]">
      <FontApplier headline={creator.secondary_font} body={creator.primary_font} />
      <header className="sticky top-0 z-20 border-b border-black/[0.06] bg-white/86 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a
            href={publicProfileUrl(creator.username, null, import.meta.env.VITE_PUBLIC_URL)}
            className="inline-flex size-10 items-center justify-center rounded-2xl border border-black/[0.07] bg-white"
          >
            <ArrowLeft className="size-4" />
          </a>
          {safeMediaUrl(creator.avatar_url) ? (
            <DecodedImage
              src={safeMediaUrl(creator.avatar_url)!}
              alt=""
              width={72}
              height={72}
              loading="eager"
              fetchPriority="high"
              className="size-9 rounded-full object-cover"
            />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-full bg-[#17213a] font-display text-white">
              {String(creator.display_name || creator.username)
                .slice(0, 1)
                .toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{product.title}</div>
            <div className="truncate text-[11px] text-[#17213a]/42">
              Private access by {creator.display_name || creator.username}
            </div>
          </div>
          <span
            className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-semibold sm:px-3 ${accessState.badgeClass}`}
          >
            <ShieldCheck className="size-3.5" /> {accessState.label}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
        <section className="relative overflow-hidden rounded-[34px] bg-[#17213a] p-6 text-white sm:p-8">
          <div
            className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full blur-3xl"
            style={{ background: `${definition.accent}55` }}
          />
          <div className="relative">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-white/65">
              <LockKeyhole className="size-3.5" /> {definition.label}
            </div>
            <h1 className="mt-4 max-w-3xl font-display text-4xl leading-[1.02] sm:text-5xl">
              Welcome to {product.title}.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/50">
              Access is tied to {grant.buyer_email}. Do not post this private URL publicly.
            </p>
            {accessState.detail && (
              <div
                className={`mt-5 inline-flex max-w-full items-center gap-2 rounded-2xl px-3.5 py-2.5 text-xs leading-5 ${accessState.noticeClass}`}
              >
                <Clock3 className="size-4 shrink-0" />
                <span>
                  {accessState.detail}
                  {accessState.date && (
                    <>
                      {" "}
                      <LocalDateTime value={accessState.date} />
                    </>
                  )}
                </span>
              </div>
            )}
          </div>
        </section>

        <div className="mt-5">
          {product.kind === "digital_product" && <Downloads product={product} token={token} />}
          {product.kind === "bundle" && (
            <BundlePortal products={data.bundleProducts || []} token={token} />
          )}
          {product.kind === "course" && (
            <CoursePortal
              lessons={data.lessons || []}
              progress={data.progress || []}
              token={token}
              onProgress={(lessonId, completedAt) =>
                setData({
                  ...data,
                  progress: completedAt
                    ? [
                        ...(data.progress || []).filter((item) => item.lesson_id !== lessonId),
                        { lesson_id: lessonId, completed_at: completedAt },
                      ]
                    : (data.progress || []).filter((item) => item.lesson_id !== lessonId),
                })
              }
            />
          )}
          {product.kind === "coaching_call" && (
            <BookingPortal
              product={product}
              bookings={data.bookings || []}
              token={token}
              now={now}
              onBooked={(booking) =>
                setData({
                  ...data,
                  bookings: [
                    booking,
                    ...(data.bookings || []).filter((item) => item.id !== booking.id),
                  ],
                })
              }
              onCanceled={(booking) =>
                setData({
                  ...data,
                  bookings: (data.bookings || []).map((item) =>
                    item.id === booking.id ? booking : item,
                  ),
                })
              }
            />
          )}
          {product.kind === "webinar" && (
            <WebinarPortal product={product} registration={data.webinarRegistration} now={now} />
          )}
          {(product.kind === "paid_community" || product.kind === "membership") && (
            <CommunityPortal
              product={product}
              posts={data.posts || []}
              comments={data.comments || []}
              notifications={data.communityNotifications || []}
              grant={grant}
              token={token}
              onPost={(post) => setData({ ...data, posts: [post, ...(data.posts || [])] })}
              onComment={(comment) =>
                setData({ ...data, comments: [...(data.comments || []), comment] })
              }
              onPreferences={(memberName, notificationsEnabled) =>
                setData({
                  ...data,
                  grant: {
                    ...data.grant,
                    member_name: memberName,
                    community_notifications_enabled: notificationsEnabled,
                  },
                })
              }
              onNotificationsRead={(ids) =>
                setData({
                  ...data,
                  communityNotifications: (data.communityNotifications || []).map((item) =>
                    ids.includes(item.id) ? { ...item, is_read: true } : item,
                  ),
                })
              }
              onModerated={(kind, contentId) =>
                setData({
                  ...data,
                  posts:
                    kind === "post"
                      ? (data.posts || []).filter((item) => item.id !== contentId)
                      : data.posts,
                  comments:
                    kind === "comment"
                      ? (data.comments || []).filter((item) => item.id !== contentId)
                      : data.comments,
                })
              }
            />
          )}
          {product.kind === "custom_product" && <CustomPortal product={product} />}
        </div>
      </main>
    </div>
  );
}

function subscriptionAccessPresentation(subscription: CommerceSubscriptionAccessRecord | null) {
  if (!subscription) {
    return {
      label: "Active access",
      detail: null,
      date: null,
      badgeClass: "bg-emerald-50 text-emerald-700",
      noticeClass: "bg-white/10 text-white/70",
    };
  }
  if (subscription.status === "past_due") {
    return {
      label: "Payment issue",
      detail: "Access remains available through",
      date: subscription.grace_expires_at,
      badgeClass: "bg-amber-50 text-amber-700",
      noticeClass: "bg-amber-300/15 text-amber-100",
    };
  }
  if (subscription.status === "cancel_at_period_end" || subscription.cancel_at_period_end) {
    return {
      label: "Ending soon",
      detail: "Your membership stays active through",
      date: subscription.current_period_end,
      badgeClass: "bg-sky-50 text-sky-700",
      noticeClass: "bg-sky-300/15 text-sky-100",
    };
  }
  return {
    label: "Active membership",
    detail: subscription.current_period_end ? "Your next membership period begins after" : null,
    date: subscription.current_period_end,
    badgeClass: "bg-emerald-50 text-emerald-700",
    noticeClass: "bg-emerald-300/15 text-emerald-100",
  };
}

function useLiveNow(initialIso: string) {
  const [now, setNow] = useState(() => new Date(initialIso));
  useEffect(() => {
    setNow(new Date());
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, [initialIso]);
  return now;
}

function LocalDateTime({ value, dateOnly = false }: { value: string; dateOnly?: boolean }) {
  const deterministic = (() => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "UTC",
          ...(dateOnly
            ? { dateStyle: "medium" as const }
            : { dateStyle: "full" as const, timeStyle: "short" as const }),
        }).format(date)
      : "";
  })();
  const [text, setText] = useState(deterministic);
  useEffect(() => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return;
    setText(
      new Intl.DateTimeFormat(undefined, {
        ...(dateOnly
          ? { dateStyle: "medium" as const }
          : { dateStyle: "full" as const, timeStyle: "short" as const }),
      }).format(date),
    );
  }, [dateOnly, value]);
  return <>{text}</>;
}

function PortalCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[30px] border border-black/[0.07] bg-white p-5 shadow-[0_24px_70px_-52px_rgba(23,33,58,.55)] sm:p-7 ${className}`}
    >
      {children}
    </section>
  );
}

function BundlePortal({
  products,
  token,
}: {
  products: CommerceAccessData["bundleProducts"];
  token: string;
}) {
  return (
    <div className="space-y-4">
      <PortalCard>
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-[#e9e4ff] text-[#8067e8]">
            <ShoppingBag className="size-5" />
          </span>
          <div>
            <h2 className="font-display text-2xl">Everything in your bundle</h2>
            <p className="text-xs text-[#17213a]/45">
              {products.length} {products.length === 1 ? "product" : "products"} unlocked with this
              private link
            </p>
          </div>
        </div>
      </PortalCard>
      {products.map(({ product, lessons }) => {
        if (product.kind === "digital_product") {
          return (
            <Downloads
              key={product.id}
              product={product}
              token={token}
              title={product.title}
              description={product.subtitle || "Private links verified on every request"}
            />
          );
        }
        if (product.kind === "course") {
          return (
            <CoursePortal
              key={product.id}
              lessons={lessons}
              progress={[]}
              token={token}
              onProgress={() => undefined}
              title={product.title}
              progressEnabled={false}
            />
          );
        }
        return <CustomPortal key={product.id} product={product} title={product.title} />;
      })}
      {!products.length && (
        <PortalCard>
          <p className="text-sm leading-6 text-[#17213a]/55">
            This bundle is temporarily unavailable. Please contact the creator for help.
          </p>
        </PortalCard>
      )}
    </div>
  );
}

function Downloads({
  product,
  token,
  title = "Your downloads",
  description = "Private links verified on every request",
}: {
  product: CommerceProductRecord;
  token: string;
  title?: string;
  description?: string;
}) {
  const files = Array.isArray(product.settings?.files) ? product.settings.files : [];
  return (
    <PortalCard>
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-[#dceaff] text-[#3478f6]">
          <Download className="size-5" />
        </span>
        <div>
          <h2 className="font-display text-2xl">{title}</h2>
          <p className="text-xs text-[#17213a]/45">{description}</p>
        </div>
      </div>
      {files.length ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {(files as CommerceAsset[]).map((file) => (
            <a
              key={file.id}
              href={`/api/commerce/download/${token}/${file.id}`}
              className="group flex items-center gap-3 rounded-2xl bg-[#f2f5fb] p-4 transition hover:bg-[#dceaff]"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-white text-[#3478f6]">
                <FileText className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{file.name}</div>
                <div className="text-[10px] text-[#17213a]/40">
                  {Math.max(1, Math.round(Number(file.size || 0) / 1024))} KB
                </div>
              </div>
              <Download className="size-4 text-[#17213a]/28 transition group-hover:translate-y-0.5" />
            </a>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-[#17213a]/12 bg-[#f7f8fc] p-5 text-sm leading-6 text-[#17213a]/48">
          This download is temporarily unavailable. The creator has been asked to restore the buyer
          files.
        </div>
      )}
    </PortalCard>
  );
}

export function CoursePortal({
  lessons,
  progress,
  token,
  onProgress,
  title = "Lessons",
  progressEnabled = true,
}: {
  lessons: CommerceLesson[];
  progress: Array<{ lesson_id: string; completed_at: string }>;
  token: string;
  onProgress: (lessonId: string, completedAt: string | null) => void;
  title?: string;
  progressEnabled?: boolean;
}) {
  const [active, setActive] = useState(0);
  const lesson = lessons[active];
  const completed = new Set(progress.map((item) => item.lesson_id));
  const completedCount = lessons.filter((item) => completed.has(item.id)).length;
  const completion = lessons.length ? Math.round((completedCount / lessons.length) * 100) : 0;
  const progressMutation = useMutation({
    mutationFn: (input: { lessonId: string; completed: boolean; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return setCommerceCourseLessonProgress({
        data: { token, lessonId: input.lessonId, completed: input.completed },
      });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onProgress(result.lesson_id, result.completed_at);
      toast.success(result.completed ? "Lesson completed" : "Lesson marked incomplete");
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Progress could not be saved");
    },
  });
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_select_customer_course_lesson",
        title: "Select customer course lesson",
        description:
          "Selects one visible lesson in this private course after Bento shows a browser approval dialog. It does not open private resource URLs.",
        inputSchema: {
          type: "object",
          properties: { lessonId: { type: "string", format: "uuid" } },
          required: ["lessonId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>) => {
          const lessonId = typeof input.lessonId === "string" ? input.lessonId : "";
          const lessonIndex = lessons.findIndex((item) => item.id === lessonId);
          if (lessonIndex < 0) throw new Error("Choose a lesson available in this course.");
          await requireWebMcpUserConfirmation("Select customer course lesson", {
            lessonId,
            title: safeWebMcpText(lessons[lessonIndex].title, 300),
          });
          setActive(lessonIndex);
          return webMcpResult("Selected the course lesson in the visible portal.", {
            lessonId,
            position: lessonIndex + 1,
            title: safeWebMcpText(lessons[lessonIndex].title, 300),
          });
        },
      },
      {
        name: "bento_set_customer_lesson_progress",
        title: "Set customer lesson progress",
        description:
          "Marks one lesson complete or incomplete after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            lessonId: { type: "string", format: "uuid" },
            completed: { type: "boolean" },
          },
          required: ["lessonId", "completed"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const lessonId = typeof input.lessonId === "string" ? input.lessonId : "";
          const target = lessons.find((item) => item.id === lessonId);
          if (!target) throw new Error("Choose a lesson available in this course.");
          if (typeof input.completed !== "boolean") {
            throw new Error("Choose whether the lesson is complete.");
          }
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Update customer lesson progress", {
            lessonId,
            title: safeWebMcpText(target.title, 300),
            completed: input.completed,
          });
          signal.throwIfAborted();
          const result = await progressMutation.mutateAsync({
            lessonId,
            completed: input.completed,
            signal,
          });
          signal.throwIfAborted();
          return webMcpResult(
            result.completed ? "Marked the lesson complete." : "Marked the lesson incomplete.",
            {
              lessonId: result.lesson_id,
              completed: result.completed,
              completedAt: result.completed_at,
            },
          );
        },
      },
    ],
    [lessons, progressMutation],
  );
  useWebMcpTools(progressEnabled ? webMcpTools : []);
  return (
    <div className="grid gap-4 lg:grid-cols-[310px_1fr]">
      <PortalCard>
        <div className="flex items-center gap-3">
          <GraduationCap className="size-5 text-[#b47800]" />
          <h2 className="font-display text-2xl">{title}</h2>
        </div>
        {progressEnabled && (
          <div className="mt-4 rounded-2xl bg-[#f7f8fc] p-3">
            <div className="flex items-center justify-between text-[11px] font-semibold">
              <span>{completedCount} completed</span>
              <span className="text-[#17213a]/42">{completion}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e8ebf1]">
              <div
                className="h-full rounded-full bg-[#f1a900] transition-[width]"
                style={{ width: `${completion}%` }}
              />
            </div>
          </div>
        )}
        <div className="mt-4 space-y-2">
          {(lessons as CommerceLesson[]).map((item, index) => (
            <button
              type="button"
              key={item.id || index}
              onClick={() => setActive(index)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm transition ${active === index ? "bg-[#fff3c6] text-[#7b5800]" : "bg-[#f7f8fc] hover:bg-[#f2f5fb]"}`}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-white text-xs font-semibold">
                {index + 1}
              </span>
              <span className="line-clamp-2">{item.title}</span>
              {progressEnabled && completed.has(item.id) && (
                <CheckCircle2 className="ml-auto size-4 shrink-0 text-emerald-600" />
              )}
            </button>
          ))}
        </div>
      </PortalCard>
      <PortalCard className="min-h-[320px]">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/40">
          <PlayCircle className="size-4" /> {lesson?.moduleTitle || "Course"} · Lesson {active + 1}
        </div>
        <h2 className="mt-3 font-display text-3xl">{lesson?.title || "Course lesson"}</h2>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-[#17213a]/60">
          {lesson?.body || lesson?.summary || "Your creator is preparing this lesson."}
        </p>
        {safeNavigationHref(lesson?.url) && (
          <a
            href={safeNavigationHref(lesson?.url)!}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-[#17213a] px-4 py-3 text-sm font-semibold text-white"
          >
            Open lesson resource <ExternalLink className="size-4" />
          </a>
        )}
        {lesson && (
          <div className="mt-8 flex flex-col gap-3 border-t border-black/[0.06] pt-5 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => setActive((value) => Math.max(0, value - 1))}
              disabled={active === 0}
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-black/[0.07] bg-white px-4 py-3 text-sm font-semibold disabled:opacity-35"
            >
              <ChevronLeft className="size-4" /> Previous
            </button>
            {progressEnabled && (
              <button
                type="button"
                disabled={progressMutation.isPending}
                onClick={() =>
                  progressMutation.mutate({
                    lessonId: lesson.id,
                    completed: !completed.has(lesson.id),
                  })
                }
                className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold sm:ml-auto ${
                  completed.has(lesson.id)
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-[#17213a] text-white"
                }`}
              >
                <CheckCircle2 className="size-4" />
                {completed.has(lesson.id) ? "Completed" : "Mark complete"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setActive((value) => Math.min(lessons.length - 1, value + 1))}
              disabled={active >= lessons.length - 1}
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-black/[0.07] bg-white px-4 py-3 text-sm font-semibold disabled:opacity-35"
            >
              Next <ChevronRight className="size-4" />
            </button>
          </div>
        )}
      </PortalCard>
    </div>
  );
}

export function BookingPortal({
  product,
  bookings,
  token,
  now,
  onBooked,
  onCanceled,
}: {
  product: CommerceProductRecord;
  bookings: CommerceBookingRecord[];
  token: string;
  now: Date;
  onBooked: (booking: CommerceBookingRecord) => void;
  onCanceled: (booking: CommerceBookingRecord) => void;
}) {
  const [startsAt, setStartsAt] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const activeBooking = bookings.find((item) => ["pending", "confirmed"].includes(item.status));
  const slots = useQuery({
    queryKey: ["commerce-booking-slots", token],
    queryFn: () => getAvailableCommerceBookingSlots({ data: { token } }),
    staleTime: 30_000,
    enabled: !activeBooking,
  });
  const timezone = browserTimeZone();
  const slotsByDay = useMemo(() => {
    const grouped = new Map<string, Array<{ startsAt: string }>>();
    const formatter = new Intl.DateTimeFormat("en", {
      dateStyle: "full",
      timeZone: timezone,
    });
    for (const slot of slots.data?.slots || []) {
      const day = formatter.format(new Date(slot.startsAt));
      grouped.set(day, [...(grouped.get(day) || []), slot]);
    }
    return Array.from(grouped);
  }, [slots.data?.slots, timezone]);
  const booking = useMutation({
    mutationFn: (input: {
      startsAt: string;
      name: string;
      notes?: string;
      signal?: AbortSignal;
    }) => {
      input.signal?.throwIfAborted();
      return createCommerceBooking({
        data: {
          token,
          startsAt: input.startsAt,
          timezone,
          name: input.name,
          notes: input.notes,
        },
      });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onBooked(result);
      toast.success("Call booked");
      setStartsAt("");
      void slots.refetch();
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Could not book call");
    },
  });
  const cancellation = useMutation({
    mutationFn: (input: { bookingId: string; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return cancelCommerceBooking({ data: { token, bookingId: input.bookingId } });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onCanceled(result);
      toast.success("Booking canceled. Choose another time when you are ready.");
      void slots.refetch();
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Could not cancel booking");
    },
  });
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_customer_booking_availability",
        title: "Get customer booking availability",
        description:
          "Returns bounded available call times and existing booking status from this private customer portal. Meeting and recording URLs are omitted.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async (_input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          signal.throwIfAborted();
          const availability = activeBooking
            ? slots.data
            : await getAvailableCommerceBookingSlots({ data: { token } });
          signal.throwIfAborted();
          return webMcpResult("Loaded private customer booking availability.", {
            timezone,
            durationMinutes: Number(product.settings?.durationMinutes || 60),
            bookings: bookings.slice(0, 100).map(safeWebMcpBooking),
            slots: (availability?.slots || []).slice(0, 100).map((slot) => ({
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
            })),
          });
        },
      },
      {
        name: "bento_create_customer_booking",
        title: "Create customer booking",
        description:
          "Books one available coaching-call time after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            startsAt: { type: "string", format: "date-time" },
            name: { type: "string", minLength: 1, maxLength: 120 },
            notes: { type: "string", maxLength: 3_000 },
          },
          required: ["startsAt", "name"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          if (activeBooking) throw new Error("Cancel the active booking before choosing another.");
          const parsedStartsAt =
            typeof input.startsAt === "string" ? new Date(input.startsAt) : new Date(NaN);
          const nextName = typeof input.name === "string" ? input.name.trim() : "";
          const nextNotes = typeof input.notes === "string" ? input.notes.trim() : "";
          if (!Number.isFinite(parsedStartsAt.getTime()))
            throw new Error("Choose a valid call time.");
          if (!nextName || nextName.length > 120)
            throw new Error("Keep the name between 1 and 120 characters.");
          if (nextNotes.length > 3_000) throw new Error("Keep notes under 3,000 characters.");
          const normalizedStartsAt = parsedStartsAt.toISOString();
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Create customer booking", {
            startsAt: normalizedStartsAt,
            timezone,
            name: nextName,
            notes: nextNotes || undefined,
          });
          signal.throwIfAborted();
          const result = await booking.mutateAsync({
            startsAt: normalizedStartsAt,
            name: nextName,
            notes: nextNotes || undefined,
            signal,
          });
          signal.throwIfAborted();
          return webMcpResult("Created the customer booking.", {
            booking: safeWebMcpBooking(result),
          });
        },
      },
      {
        name: "bento_cancel_customer_booking",
        title: "Cancel customer booking",
        description:
          "Cancels one future active booking after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: { bookingId: { type: "string", format: "uuid" } },
          required: ["bookingId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const bookingId = typeof input.bookingId === "string" ? input.bookingId : "";
          const target = bookings.find((item) => item.id === bookingId);
          if (
            !target ||
            !["pending", "confirmed"].includes(target.status) ||
            new Date(target.starts_at).getTime() <= now.getTime()
          ) {
            throw new Error("Choose a future active booking from this portal.");
          }
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Cancel customer booking", {
            bookingId,
            startsAt: target.starts_at,
          });
          signal.throwIfAborted();
          const result = await cancellation.mutateAsync({ bookingId, signal });
          signal.throwIfAborted();
          return webMcpResult("Canceled the customer booking.", {
            booking: safeWebMcpBooking(result),
          });
        },
      },
    ],
    [activeBooking, booking, bookings, cancellation, now, product, slots, timezone, token],
  );
  useWebMcpTools(webMcpTools);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PortalCard>
        <div className="flex items-center gap-3">
          <CalendarDays className="size-5 text-[#8067e8]" />
          <h2 className="font-display text-2xl">Choose a time</h2>
        </div>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/50">
          {product.settings?.availabilitySummary ||
            "Choose a future date and time. The creator will confirm any schedule changes directly."}
        </p>
        {activeBooking ? (
          <div className="mt-5 rounded-2xl bg-[#f2f5fb] p-5 text-sm leading-6 text-[#17213a]/58">
            You already have a confirmed time. Cancel it from <strong>Your bookings</strong> to
            choose a new slot with this same private access link.
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              booking.mutate({
                startsAt: new Date(startsAt).toISOString(),
                name,
                notes: notes || undefined,
              });
            }}
            className="mt-5 space-y-3"
          >
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className={inputClass}
            />
            <div className="rounded-2xl border border-black/[0.08] bg-[#f8faff] p-3">
              <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/40">
                <span>Available times</span>
              </div>
              {slots.isPending ? (
                <div className="flex h-28 items-center justify-center text-sm text-[#17213a]/45">
                  <Loader2 className="mr-2 size-4 animate-spin" /> Checking calendars…
                </div>
              ) : slots.error ? (
                <div className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">
                  {slots.error instanceof Error
                    ? slots.error.message
                    : "Could not load availability."}
                </div>
              ) : slots.data?.slots.length ? (
                <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                  {slotsByDay.map(([day, daySlots]) => (
                    <div key={day}>
                      <div className="mb-1.5 text-xs font-semibold text-[#17213a]/65">{day}</div>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {daySlots.slice(0, 12).map((slot) => (
                          <button
                            key={slot.startsAt}
                            type="button"
                            onClick={() => setStartsAt(slot.startsAt)}
                            className={`rounded-xl px-2 py-2 text-xs font-semibold transition ${
                              startsAt === slot.startsAt
                                ? "bg-[#8067e8] text-white"
                                : "bg-white text-[#17213a] hover:bg-[#e9e4ff]"
                            }`}
                          >
                            {new Intl.DateTimeFormat("en", {
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone: timezone,
                            }).format(new Date(slot.startsAt))}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex h-28 items-center justify-center text-center text-sm text-[#17213a]/45">
                  No open times right now. Please check again later.
                </div>
              )}
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the creator should know?"
              className={`${inputClass} min-h-24`}
            />
            <button
              type="submit"
              disabled={booking.isPending || !startsAt}
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#8067e8] px-4 py-3 text-sm font-semibold text-white"
            >
              {booking.isPending && <Loader2 className="size-4 animate-spin" />} Book{" "}
              {product.settings?.durationMinutes || 60} minutes
            </button>
          </form>
        )}
      </PortalCard>
      <PortalCard>
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/40">
          Your bookings
        </div>
        <div className="mt-4 space-y-3">
          {bookings.length ? (
            bookings.map((item) => (
              <div key={item.id} className="rounded-2xl bg-[#f2f5fb] p-4">
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  <Clock3 className="size-4 text-[#8067e8]" />{" "}
                  <LocalDateTime value={item.starts_at} />
                  {item.status === "canceled" && (
                    <span className="rounded-full bg-white px-2 py-1 text-[10px] uppercase tracking-wide text-[#17213a]/45">
                      Canceled
                    </span>
                  )}
                </div>
                {item.status !== "canceled" && safeNavigationHref(item.meeting_url) && (
                  <a
                    href={safeNavigationHref(item.meeting_url)!}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#3478f6]"
                  >
                    Open meeting <ExternalLink className="size-3.5" />
                  </a>
                )}
                {item.status !== "canceled" &&
                  item.recording_status === "ready" &&
                  safeNavigationHref(item.recording_share_url) && (
                    <a
                      href={safeNavigationHref(item.recording_share_url)!}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-4 mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#8067e8]"
                    >
                      Watch recording <PlayCircle className="size-3.5" />
                    </a>
                  )}
                {["pending", "confirmed"].includes(item.status) &&
                  new Date(item.starts_at).getTime() > now.getTime() && (
                    <button
                      type="button"
                      disabled={cancellation.isPending}
                      onClick={() => cancellation.mutate({ bookingId: item.id })}
                      className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-3 py-2.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50 sm:w-auto"
                    >
                      {cancellation.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <CalendarX2 className="size-3.5" />
                      )}
                      Cancel or choose another time
                    </button>
                  )}
              </div>
            ))
          ) : (
            <p className="text-sm text-[#17213a]/45">No call booked yet.</p>
          )}
        </div>
      </PortalCard>
    </div>
  );
}

function WebinarPortal({
  product,
  registration,
  now,
}: {
  product: CommerceProductRecord;
  registration: WebinarRegistrationRecord | null;
  now: Date;
}) {
  if (!registration) {
    return (
      <PortalCard>
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-[#ffe2e4] text-[#e24c5a]">
            <Radio className="size-5" />
          </span>
          <div>
            <h2 className="font-display text-2xl">Preparing attendee access</h2>
            <p className="text-xs text-[#17213a]/45">
              Refresh shortly. Your purchase and seat are safe.
            </p>
          </div>
        </div>
      </PortalCard>
    );
  }
  const accessState = webinarAccessState(registration, now);
  const joinReady = canOpenWebinarJoinLink(registration, now);
  const replayReady = canOpenWebinarReplay(registration, now);
  const joinUrl = safeNavigationHref(registration.join_url);
  const replayUrl = safeNavigationHref(registration.replay_url);
  const statusCopy =
    registration.status === "canceled"
      ? "Registration canceled"
      : accessState === "live"
        ? "Live now"
        : accessState === "ended"
          ? "Event ended"
          : "Seat confirmed";
  return (
    <PortalCard>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-[#ffe2e4] text-[#e24c5a]">
          <Radio className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-2xl">Attendee access</h2>
          <p className="text-xs text-[#17213a]/45">Private event details for {product.title}</p>
        </div>
        <span className="sm:ml-auto inline-flex w-fit rounded-full bg-[#ffe2e4] px-3 py-1.5 text-[10px] font-semibold text-[#b52f3d]">
          {statusCopy}
        </span>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-[#f7f8fc] p-4">
          <CalendarDays className="size-4 text-[#e24c5a]" />
          <div className="mt-2 text-sm font-semibold">
            <LocalDateTime value={registration.starts_at} />
          </div>
          <div className="mt-1 text-[10px] text-[#17213a]/40">Shown in your local time</div>
        </div>
        <div className="rounded-2xl bg-[#f7f8fc] p-4">
          <Clock3 className="size-4 text-[#e24c5a]" />
          <div className="mt-2 text-sm font-semibold">
            {Math.max(
              1,
              Math.round(
                (new Date(registration.ends_at).getTime() -
                  new Date(registration.starts_at).getTime()) /
                  60_000,
              ),
            )}{" "}
            minutes
          </div>
        </div>
      </div>
      {joinReady && joinUrl ? (
        <a
          href={joinUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#e24c5a] px-5 py-3 text-sm font-semibold text-white sm:w-auto"
        >
          Join webinar <ExternalLink className="size-4" />
        </a>
      ) : registration.status === "canceled" ? (
        <div className="mt-5 rounded-2xl bg-[#f7f8fc] px-4 py-3 text-sm text-[#17213a]/55">
          This attendee registration is no longer active.
        </div>
      ) : accessState === "upcoming" ? (
        <div className="mt-5 rounded-2xl bg-[#fff3c6] px-4 py-3 text-sm text-[#7b5800]">
          The private room opens 15 minutes before the event.
        </div>
      ) : (
        <div className="mt-5 rounded-2xl bg-[#fff3c6] px-4 py-3 text-sm text-[#7b5800]">
          {joinUrl
            ? "The live room is closed. Check below for the replay."
            : "The creator has not added a private room link yet."}
        </div>
      )}
      {replayReady && replayUrl && (
        <a
          href={replayUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white sm:ml-2 sm:mt-5 sm:w-auto"
        >
          Watch replay <PlayCircle className="size-4" />
        </a>
      )}
    </PortalCard>
  );
}

export function CommunityPortal({
  product,
  posts,
  comments,
  notifications,
  grant,
  token,
  onPost,
  onComment,
  onPreferences,
  onNotificationsRead,
  onModerated,
}: {
  product: CommerceProductRecord;
  posts: CommerceCommunityPostRecord[];
  comments: CommerceCommunityCommentRecord[];
  notifications: CommerceCommunityNotificationRecord[];
  grant: CommerceAccessData["grant"];
  token: string;
  onPost: (post: CommerceCommunityPostRecord) => void;
  onComment: (comment: CommerceCommunityCommentRecord) => void;
  onPreferences: (memberName: string, notificationsEnabled: boolean) => void;
  onNotificationsRead: (ids: string[]) => void;
  onModerated: (kind: "post" | "comment", contentId: string) => void;
}) {
  const [body, setBody] = useState("");
  const [commentBodies, setCommentBodies] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState(
    grant.member_name || grant.buyer_email.split("@")[0] || "Member",
  );
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    grant.community_notifications_enabled !== false,
  );
  const post = useMutation({
    mutationFn: (input: { body: string; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return createCommerceCommunityPost({ data: { token, body: input.body } });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onPost(result);
      setBody("");
      toast.success("Posted");
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Could not post");
    },
  });
  const comment = useMutation({
    mutationFn: (input: { postId: string; body: string; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return createCommerceCommunityComment({
        data: { token, postId: input.postId, body: input.body },
      });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onComment(result);
      setCommentBodies((current) => ({ ...current, [result.post_id]: "" }));
      toast.success("Comment added");
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Could not comment");
    },
  });
  const preferences = useMutation({
    mutationFn: (input: {
      displayName: string;
      notificationsEnabled: boolean;
      signal?: AbortSignal;
    }) => {
      input.signal?.throwIfAborted();
      return saveCommerceCommunityPreferences({
        data: {
          token,
          displayName: input.displayName,
          notificationsEnabled: input.notificationsEnabled,
        },
      });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onPreferences(result.member_name, result.community_notifications_enabled);
      toast.success("Community preferences saved");
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Preferences could not be saved");
    },
  });
  const unread = notifications.filter((item) => !item.is_read);
  const markRead = useMutation({
    mutationFn: (input: { notificationIds: string[]; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return markCommerceCommunityNotificationsRead({
        data: { token, notificationIds: input.notificationIds },
      });
    },
    onSuccess: (_result, input) => {
      input.signal?.throwIfAborted();
      onNotificationsRead(input.notificationIds);
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Notifications could not be updated");
    },
  });
  const moderate = useMutation({
    mutationFn: (input: { kind: "post" | "comment"; contentId: string; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return moderateCommerceCommunityContent({
        data: {
          token,
          kind: input.kind,
          contentId: input.contentId,
          status: "hidden",
        },
      });
    },
    onSuccess: (result, input) => {
      input.signal?.throwIfAborted();
      onModerated(result.kind, result.id);
      toast.success(`${result.kind === "post" ? "Post" : "Comment"} hidden`);
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "Content could not be moderated");
    },
  });
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_create_customer_community_post",
        title: "Create customer community post",
        description:
          "Creates a member post after Bento shows a browser approval dialog, when member posting is enabled.",
        inputSchema: {
          type: "object",
          properties: { body: { type: "string", minLength: 1, maxLength: 10_000 } },
          required: ["body"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          if (product.settings?.allowMemberPosts === false) {
            throw new Error("This community is read-only.");
          }
          const nextBody = typeof input.body === "string" ? input.body.trim() : "";
          if (!nextBody || nextBody.length > 10_000) {
            throw new Error("Keep the post between 1 and 10,000 characters.");
          }
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Create customer community post", {
            body: safeWebMcpText(nextBody, 500),
          });
          signal.throwIfAborted();
          const result = await post.mutateAsync({ body: nextBody, signal });
          signal.throwIfAborted();
          return webMcpResult("Created the community post.", {
            post: {
              id: result.id,
              authorName: safeWebMcpText(result.author_name, 120),
              body: safeWebMcpText(result.body, 5_000),
              createdAt: result.created_at,
            },
          });
        },
      },
      {
        name: "bento_create_customer_community_comment",
        title: "Create customer community comment",
        description:
          "Adds a comment to one visible community post after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            postId: { type: "string", format: "uuid" },
            body: { type: "string", minLength: 1, maxLength: 3_000 },
          },
          required: ["postId", "body"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const postId = typeof input.postId === "string" ? input.postId : "";
          if (!posts.some((item) => item.id === postId)) {
            throw new Error("Choose a post visible in this community.");
          }
          const nextBody = typeof input.body === "string" ? input.body.trim() : "";
          if (!nextBody || nextBody.length > 3_000) {
            throw new Error("Keep the comment between 1 and 3,000 characters.");
          }
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Create customer community comment", {
            postId,
            body: safeWebMcpText(nextBody, 500),
          });
          signal.throwIfAborted();
          const result = await comment.mutateAsync({ postId, body: nextBody, signal });
          signal.throwIfAborted();
          return webMcpResult("Created the community comment.", {
            comment: {
              id: result.id,
              postId: result.post_id,
              authorName: safeWebMcpText(result.author_name, 120),
              body: safeWebMcpText(result.body, 3_000),
              createdAt: result.created_at,
            },
          });
        },
      },
      {
        name: "bento_save_customer_community_preferences",
        title: "Save customer community preferences",
        description:
          "Updates the member display name and email-notification preference after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 120 },
            notificationsEnabled: { type: "boolean" },
          },
          required: ["displayName", "notificationsEnabled"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const nextDisplayName =
            typeof input.displayName === "string" ? input.displayName.trim() : "";
          if (!nextDisplayName || nextDisplayName.length > 120) {
            throw new Error("Keep the display name between 1 and 120 characters.");
          }
          if (typeof input.notificationsEnabled !== "boolean") {
            throw new Error("Choose whether community notifications are enabled.");
          }
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Save customer community preferences", {
            displayName: safeWebMcpText(nextDisplayName, 120),
            notificationsEnabled: input.notificationsEnabled,
          });
          signal.throwIfAborted();
          const result = await preferences.mutateAsync({
            displayName: nextDisplayName,
            notificationsEnabled: input.notificationsEnabled,
            signal,
          });
          signal.throwIfAborted();
          return webMcpResult("Saved the community preferences.", {
            displayName: safeWebMcpText(result.member_name, 120),
            notificationsEnabled: result.community_notifications_enabled,
          });
        },
      },
      {
        name: "bento_mark_customer_community_notifications_read",
        title: "Mark customer community notifications read",
        description:
          "Marks selected unread community notifications, or all unread notifications when omitted, after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            notificationIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 30,
              uniqueItems: true,
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const unreadIds = new Set(unread.map((item) => item.id));
          const requested = Array.isArray(input.notificationIds)
            ? input.notificationIds
            : unread.map((item) => item.id);
          if (
            requested.length > 30 ||
            requested.some((id) => typeof id !== "string" || !unreadIds.has(id))
          ) {
            throw new Error("Choose up to 30 unread notifications from this community.");
          }
          const notificationIds = [...new Set(requested as string[])];
          if (!notificationIds.length) throw new Error("There are no unread notifications.");
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Mark community notifications read", {
            count: notificationIds.length,
          });
          signal.throwIfAborted();
          const result = await markRead.mutateAsync({ notificationIds, signal });
          signal.throwIfAborted();
          return webMcpResult("Marked community notifications read.", {
            marked: result.marked,
          });
        },
      },
      {
        name: "bento_moderate_customer_community_content",
        title: "Moderate customer community content",
        description:
          "Hides one visible member post or comment when this access grant is a moderator, after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["post", "comment"] },
            contentId: { type: "string", format: "uuid" },
          },
          required: ["kind", "contentId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          if (grant.community_role !== "moderator") {
            throw new Error("Only community moderators can hide member content.");
          }
          const kind = input.kind === "post" || input.kind === "comment" ? input.kind : null;
          const contentId = typeof input.contentId === "string" ? input.contentId : "";
          const target =
            kind === "post"
              ? posts.find((item) => item.id === contentId)
              : kind === "comment"
                ? comments.find((item) => item.id === contentId)
                : null;
          if (!kind || !target || target.author_kind !== "member") {
            throw new Error("Choose visible member content from this community.");
          }
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Hide customer community content", {
            kind,
            contentId,
          });
          signal.throwIfAborted();
          const result = await moderate.mutateAsync({ kind, contentId, signal });
          signal.throwIfAborted();
          return webMcpResult(`Hid the community ${result.kind}.`, {
            kind: result.kind,
            contentId: result.id,
            status: result.status,
          });
        },
      },
    ],
    [
      comment,
      comments,
      grant.community_role,
      markRead,
      moderate,
      post,
      posts,
      preferences,
      product,
      unread,
    ],
  );
  useWebMcpTools(webMcpTools);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <PortalCard>
        <div className="flex items-center gap-3">
          <UsersRound className="size-5 text-[#24a56a]" />
          <div>
            <h2 className="font-display text-2xl">Member feed</h2>
            <p className="text-xs text-[#17213a]/45">{product.settings?.welcomeMessage}</p>
          </div>
        </div>
        <div className="mt-5 space-y-3">
          {posts.length ? (
            posts.map((item) => (
              <article key={item.id} className="rounded-[22px] bg-[#f7f8fc] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">{item.author_name}</div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[#17213a]/35">
                      <LocalDateTime value={item.created_at} dateOnly />
                    </span>
                    {grant.community_role === "moderator" && item.author_kind === "member" && (
                      <button
                        type="button"
                        onClick={() => moderate.mutate({ kind: "post", contentId: item.id })}
                        disabled={moderate.isPending}
                        className="inline-flex size-8 items-center justify-center rounded-xl text-[#17213a]/45 hover:bg-white disabled:opacity-40"
                        aria-label="Hide member post"
                        title="Hide member post"
                      >
                        <EyeOff className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#17213a]/62">
                  {item.body}
                </p>
                {!!item.resources?.length && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.resources.map((resource) => (
                      <a
                        key={`${item.id}:${resource.url}`}
                        href={safeNavigationHref(resource.url) || "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-[#17213a] shadow-sm"
                      >
                        <Link2 className="size-3.5 shrink-0" />
                        <span className="truncate">{resource.label}</span>
                      </a>
                    ))}
                  </div>
                )}
                <div className="mt-4 space-y-2 border-t border-black/[0.06] pt-3">
                  {comments
                    .filter((commentItem) => commentItem.post_id === item.id)
                    .map((commentItem) => (
                      <div
                        key={commentItem.id}
                        className="rounded-2xl bg-white px-3 py-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">{commentItem.author_name}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-[#17213a]/35">
                              <LocalDateTime value={commentItem.created_at} dateOnly />
                            </span>
                            {grant.community_role === "moderator" &&
                              commentItem.author_kind === "member" && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    moderate.mutate({
                                      kind: "comment",
                                      contentId: commentItem.id,
                                    })
                                  }
                                  disabled={moderate.isPending}
                                  className="inline-flex size-7 items-center justify-center rounded-lg text-[#17213a]/40 hover:bg-[#f7f8fc] disabled:opacity-40"
                                  aria-label="Hide member comment"
                                  title="Hide member comment"
                                >
                                  <EyeOff className="size-3" />
                                </button>
                              )}
                          </div>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap leading-5 text-[#17213a]/60">
                          {commentItem.body}
                        </p>
                      </div>
                    ))}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      comment.mutate({
                        postId: item.id,
                        body: commentBodies[item.id] || "",
                      });
                    }}
                    className="flex min-w-0 gap-2"
                  >
                    <input
                      value={commentBodies[item.id] || ""}
                      onChange={(event) =>
                        setCommentBodies((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      placeholder="Write a comment…"
                      maxLength={3_000}
                      className="min-w-0 flex-1 rounded-xl border border-black/[0.07] bg-white px-3 py-2 text-xs outline-none focus:border-[#24a56a]/45"
                    />
                    <button
                      type="submit"
                      disabled={!commentBodies[item.id]?.trim() || comment.isPending}
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#17213a] text-white disabled:opacity-40"
                      aria-label="Add comment"
                    >
                      <Send className="size-3.5" />
                    </button>
                  </form>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-[#24a56a]/25 p-7 text-center text-sm text-[#17213a]/45">
              Start the first member conversation.
            </div>
          )}
        </div>
      </PortalCard>
      <div className="space-y-4">
        {!!notifications.length && (
          <PortalCard>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="size-4 text-[#24a56a]" />
              Notifications
              {!!unread.length && (
                <span className="ml-auto rounded-full bg-[#e7f7ee] px-2 py-1 text-[10px] text-[#197a4d]">
                  {unread.length} new
                </span>
              )}
            </div>
            <div className="mt-3 space-y-2">
              {notifications.slice(0, 5).map((item) => (
                <div
                  key={item.id}
                  className={`rounded-2xl px-3 py-3 text-xs ${
                    item.is_read ? "bg-[#f7f8fc]" : "bg-[#e7f7ee]"
                  }`}
                >
                  <div className="font-semibold">{item.title}</div>
                  {item.body && (
                    <div className="mt-1 line-clamp-2 text-[#17213a]/55">{item.body}</div>
                  )}
                </div>
              ))}
            </div>
            {!!unread.length && (
              <button
                type="button"
                onClick={() => markRead.mutate({ notificationIds: unread.map((item) => item.id) })}
                disabled={markRead.isPending}
                className="mt-3 text-xs font-semibold text-[#197a4d]"
              >
                Mark all as read
              </button>
            )}
          </PortalCard>
        )}
        <PortalCard>
          {product.settings?.allowMemberPosts !== false ? (
            <>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <MessageCircle className="size-4 text-[#24a56a]" /> Share with the community
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  post.mutate({ body });
                }}
                className="mt-4 space-y-3"
              >
                <textarea
                  required
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write a post…"
                  className={`${inputClass} min-h-32`}
                />
                <button
                  type="submit"
                  disabled={post.isPending}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#24a56a] px-4 py-3 text-sm font-semibold text-white"
                >
                  {post.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}{" "}
                  Post
                </button>
              </form>
            </>
          ) : (
            <div className="rounded-2xl bg-[#e7f7ee] p-4">
              <div className="text-sm font-semibold text-[#197a4d]">Creator updates</div>
              <p className="mt-1 text-xs leading-5 text-[#197a4d]/75">
                This community is read-only. New updates are published by the creator.
              </p>
            </div>
          )}
          {product.settings?.rules && (
            <div className="mt-4 rounded-2xl bg-[#e7f7ee] px-3 py-3 text-xs leading-5 text-[#197a4d]">
              {product.settings.rules}
            </div>
          )}
        </PortalCard>
        <PortalCard>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {notificationsEnabled ? (
              <Bell className="size-4 text-[#24a56a]" />
            ) : (
              <BellOff className="size-4 text-[#17213a]/45" />
            )}
            Your community profile
          </div>
          <label className="mt-4 block text-xs font-medium text-[#17213a]/55">
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={120}
              className={`${inputClass} mt-1.5`}
            />
          </label>
          <label className="mt-3 flex items-center gap-3 rounded-2xl bg-[#f7f8fc] px-3 py-3 text-xs">
            <input
              type="checkbox"
              checked={notificationsEnabled}
              onChange={(event) => setNotificationsEnabled(event.target.checked)}
              className="size-4 accent-[#24a56a]"
            />
            Email me creator updates
          </label>
          <button
            type="button"
            onClick={() => preferences.mutate({ displayName, notificationsEnabled })}
            disabled={!displayName.trim() || preferences.isPending}
            className="mt-3 inline-flex w-full items-center justify-center rounded-2xl bg-[#17213a] px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Save preferences
          </button>
        </PortalCard>
      </div>
    </div>
  );
}

function CustomPortal({
  product,
  title = "Your request is confirmed",
}: {
  product: CommerceProductRecord;
  title?: string;
}) {
  return (
    <PortalCard>
      <div className="flex items-center gap-3">
        <Check className="size-5 text-emerald-600" />
        <h2 className="font-display text-2xl">{title}</h2>
      </div>
      <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-[#17213a]/60">
        {product.settings?.fulfillmentInstructions ||
          "The creator will contact you with the next steps."}
      </p>
    </PortalCard>
  );
}

const inputClass =
  "w-full rounded-2xl border border-black/[0.08] bg-[#f8faff] px-4 py-3 text-sm outline-none placeholder:text-[#17213a]/30 focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10";

function InvalidAccess() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f7f8fc] px-4">
      <div className="max-w-md text-center">
        <span className="mx-auto flex size-16 items-center justify-center rounded-[24px] bg-[#ffe2e4] text-[#e24c5a]">
          <LockKeyhole className="size-7" />
        </span>
        <h1 className="mt-5 font-display text-4xl">This access link is not active.</h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/50">
          It may have expired, been refunded, or the URL may be incomplete.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
        >
          <BentoBrand iconClassName="size-5" textClassName="text-white" />
        </Link>
      </div>
    </div>
  );
}
