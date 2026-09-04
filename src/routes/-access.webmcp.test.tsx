import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WebMcpTool } from "@/lib/webmcp";

const mocks = vi.hoisted(() => ({
  getCommerceAccess: vi.fn(),
  setProgress: vi.fn(),
  createBooking: vi.fn(),
  cancelBooking: vi.fn(),
  createPost: vi.fn(),
  createComment: vi.fn(),
  savePreferences: vi.fn(),
  markNotificationsRead: vi.fn(),
  moderateContent: vi.fn(),
  getSlots: vi.fn(),
}));

vi.mock("@/lib/commerce.functions", () => ({
  getCommerceAccess: mocks.getCommerceAccess,
  setCommerceCourseLessonProgress: mocks.setProgress,
  createCommerceBooking: mocks.createBooking,
  cancelCommerceBooking: mocks.cancelBooking,
  createCommerceCommunityPost: mocks.createPost,
  createCommerceCommunityComment: mocks.createComment,
  saveCommerceCommunityPreferences: mocks.savePreferences,
  markCommerceCommunityNotificationsRead: mocks.markNotificationsRead,
  moderateCommerceCommunityContent: mocks.moderateContent,
}));

vi.mock("@/lib/booking.functions", () => ({
  getAvailableCommerceBookingSlots: mocks.getSlots,
}));

vi.mock("@/lib/timezones", () => ({ browserTimeZone: () => "UTC" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  BookingPortal,
  commerceAccessWebMcpSnapshot,
  commerceAccessWebMcpTools,
  CommunityPortal,
  CoursePortal,
} from "./access.$token";
import { useWebMcpTools } from "@/lib/webmcp";

const ACCESS_TOKEN = "private-access-token-that-must-never-leak";
const NOW = new Date("2026-08-30T10:00:00.000Z");
const LESSON_ONE_ID = "11111111-1111-4111-8111-111111111111";
const LESSON_TWO_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "33333333-3333-4333-8333-333333333333";
const POST_ID = "44444444-4444-4444-8444-444444444444";
const COMMENT_ID = "55555555-5555-4555-8555-555555555555";
const NOTIFICATION_ID = "66666666-6666-4666-8666-666666666666";

let registerTool: ReturnType<typeof vi.fn>;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function ToolHarness({ tools }: { tools: WebMcpTool[] }) {
  useWebMcpTools(tools);
  return null;
}

function registeredTool(name: string) {
  const found = registerTool.mock.calls
    .map(([candidate]) => candidate as WebMcpTool)
    .filter((candidate) => candidate.name === name)
    .at(-1);
  if (!found) throw new Error(`Missing WebMCP tool ${name}`);
  return found;
}

function execute(tool: WebMcpTool, input: Record<string, unknown> = {}) {
  return tool.execute(input, { signal: new AbortController().signal });
}

function executeWithSignal(
  tool: WebMcpTool,
  signal: AbortSignal,
  input: Record<string, unknown> = {},
) {
  return tool.execute(input, { signal });
}

function baseProduct(kind = "membership") {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    kind,
    status: "published",
    slug: "private-product",
    public_slug: "private-product",
    title: "Private course https://private.example/course",
    subtitle: "Buyer buyer@example.com",
    description: `Bearer ${ACCESS_TOKEN}`,
    cover_url: "https://private.example/cover.jpg",
    pricing_type: "free",
    price_amount: 0,
    currency: "USD",
    billing_interval: null,
    cta_label: "Open",
    settings: {
      allowMemberPosts: true,
      files: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          name: "buyer@example.com https://private.example/file",
          size: 1024,
          mimeType: "application/pdf",
        },
      ],
      fulfillmentInstructions: `/access/${ACCESS_TOKEN}`,
    },
    inventory_limit: null,
    sales_count: 1,
    noindex: true,
  };
}

function accessData(kind = "membership") {
  return {
    product: baseProduct(kind),
    creator: {
      username: "creator",
      display_name: "Creator",
      avatar_url: "https://private.example/avatar.jpg",
      primary_font: null,
      secondary_font: null,
    },
    grant: {
      id: "99999999-9999-4999-8999-999999999999",
      buyer_email: "buyer@example.com",
      member_name: "buyer@example.com",
      community_role: "moderator",
      community_notifications_enabled: true,
    },
    bookings: [
      {
        id: BOOKING_ID,
        starts_at: "2026-08-31T10:00:00.000Z",
        ends_at: "2026-08-31T11:00:00.000Z",
        timezone: "UTC",
        meeting_url: `https://meet.example/${ACCESS_TOKEN}`,
        recording_status: "ready",
        recording_share_url: `https://recording.example/${ACCESS_TOKEN}`,
        status: "confirmed",
      },
    ],
    posts: [
      {
        id: POST_ID,
        author_kind: "member",
        author_name: "buyer@example.com",
        body: `Read https://private.example/${ACCESS_TOKEN}`,
        is_pinned: false,
        resources: [{ label: "Secret", url: `https://private.example/${ACCESS_TOKEN}` }],
        created_at: "2026-08-29T10:00:00.000Z",
      },
    ],
    comments: [
      {
        id: COMMENT_ID,
        post_id: POST_ID,
        author_kind: "member",
        author_name: "buyer@example.com",
        body: `Bearer ${ACCESS_TOKEN}`,
        created_at: "2026-08-29T11:00:00.000Z",
      },
    ],
    communityNotifications: [
      {
        id: NOTIFICATION_ID,
        post_id: POST_ID,
        comment_id: COMMENT_ID,
        kind: "comment",
        title: "buyer@example.com replied",
        body: `https://private.example/${ACCESS_TOKEN}`,
        is_read: false,
        created_at: "2026-08-29T12:00:00.000Z",
      },
    ],
    webinarRegistration: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      access_grant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      order_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      product_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      creator_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      buyer_email: "buyer@example.com",
      buyer_name: "Buyer",
      starts_at: "2026-08-30T09:30:00.000Z",
      ends_at: "2026-08-30T10:30:00.000Z",
      timezone: "UTC",
      join_url: `https://webinar.example/${ACCESS_TOKEN}`,
      replay_url: `https://replay.example/${ACCESS_TOKEN}`,
      status: "confirmed",
      reminder_24h_sent_at: null,
      reminder_1h_sent_at: null,
      replay_ready_notified_at: null,
      attended_at: null,
      created_at: "2026-08-20T10:00:00.000Z",
      updated_at: "2026-08-20T10:00:00.000Z",
    },
    lessons: [
      {
        id: LESSON_ONE_ID,
        title: "Secret lesson",
        body: `Open https://lesson.example/${ACCESS_TOKEN}`,
        url: `https://resource.example/${ACCESS_TOKEN}`,
      },
    ],
    bundleProducts: [],
    progress: [{ lesson_id: LESSON_ONE_ID, completed_at: "2026-08-29T10:00:00.000Z" }],
    subscription: null,
    serverNow: NOW.toISOString(),
  } as unknown as Parameters<typeof commerceAccessWebMcpSnapshot>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  registerTool = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as Document & { modelContext?: unknown }).modelContext;
});

describe("private customer access WebMCP", () => {
  it("discovers a bounded portal reader and strips tokens, emails, and private URLs", async () => {
    const data = accessData();
    render(<ToolHarness tools={commerceAccessWebMcpTools(data, NOW) as unknown as WebMcpTool[]} />);
    await waitFor(() => expect(registerTool).toHaveBeenCalledOnce());

    const tool = registeredTool("bento_get_customer_portal");
    const result = execute(tool) as ReturnType<typeof commerceAccessWebMcpSnapshot> & {
      structuredContent?: unknown;
    };
    const serialized = JSON.stringify(result);
    const schema = JSON.stringify(tool.inputSchema);

    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain("buyer@example.com");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("meeting_url");
    expect(serialized).not.toContain("recording_share_url");
    expect(schema).not.toContain("token");
    expect(commerceAccessWebMcpSnapshot(data, NOW).bookings[0]).toMatchObject({
      meetingAvailable: true,
      recordingAvailable: true,
    });

    const courseProjection = commerceAccessWebMcpSnapshot(accessData("course"), NOW);
    expect(courseProjection.course?.lessons[0]).toMatchObject({
      id: LESSON_ONE_ID,
      resourceAvailable: true,
      completed: true,
    });
    expect(JSON.stringify(courseProjection)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(courseProjection)).not.toContain("https://");
  });

  it("selects lessons locally and saves progress only after native confirmation", async () => {
    mocks.setProgress.mockResolvedValue({
      lesson_id: LESSON_TWO_ID,
      completed: true,
      completed_at: "2026-08-30T11:00:00.000Z",
    });
    const onProgress = vi.fn();
    render(
      <CoursePortal
        lessons={[
          { id: LESSON_ONE_ID, title: "First", body: "First body" },
          { id: LESSON_TWO_ID, title: "Second", body: "Second body" },
        ]}
        progress={[]}
        token={ACCESS_TOKEN}
        onProgress={onProgress}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(registeredTool("bento_set_customer_lesson_progress")).toBeTruthy());

    await act(async () => {
      await execute(registeredTool("bento_select_customer_course_lesson"), {
        lessonId: LESSON_TWO_ID,
      });
    });
    expect(screen.getByText("Second body")).toBeVisible();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await expect(
      execute(registeredTool("bento_set_customer_lesson_progress"), {
        lessonId: LESSON_TWO_ID,
        completed: true,
      }),
    ).rejects.toThrow("did not approve");
    expect(mocks.setProgress).not.toHaveBeenCalled();

    await act(async () => {
      await execute(registeredTool("bento_set_customer_lesson_progress"), {
        lessonId: LESSON_TWO_ID,
        completed: true,
      });
    });
    expect(mocks.setProgress).toHaveBeenCalledWith({
      data: { token: ACCESS_TOKEN, lessonId: LESSON_TWO_ID, completed: true },
    });
    expect(onProgress).toHaveBeenCalledWith(LESSON_TWO_ID, "2026-08-30T11:00:00.000Z");
    expect(
      JSON.stringify(registeredTool("bento_set_customer_lesson_progress").inputSchema),
    ).not.toContain("token");
  });

  it("does not apply lesson progress after a WebMCP request is canceled in flight", async () => {
    let resolveProgress!: (value: unknown) => void;
    mocks.setProgress.mockImplementation(
      () => new Promise((resolve) => (resolveProgress = resolve)),
    );
    const onProgress = vi.fn();
    render(
      <CoursePortal
        lessons={[{ id: LESSON_ONE_ID, title: "First", body: "First body" }]}
        progress={[]}
        token={ACCESS_TOKEN}
        onProgress={onProgress}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(registeredTool("bento_set_customer_lesson_progress")).toBeTruthy());

    const controller = new AbortController();
    const outcome = Promise.resolve(
      executeWithSignal(registeredTool("bento_set_customer_lesson_progress"), controller.signal, {
        lessonId: LESSON_ONE_ID,
        completed: true,
      }),
    ).catch((error) => error);
    await waitFor(() => expect(mocks.setProgress).toHaveBeenCalledOnce());
    controller.abort();
    resolveProgress({
      lesson_id: LESSON_ONE_ID,
      completed: true,
      completed_at: "2026-08-30T11:00:00.000Z",
    });

    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("rejects pre-canceled private access actions before confirmation or dispatch", async () => {
    mocks.getSlots.mockResolvedValue({ slots: [] });
    const aborted = new AbortController();
    aborted.abort();

    render(
      <CoursePortal
        lessons={[{ id: LESSON_ONE_ID, title: "First", body: "First body" }]}
        progress={[]}
        token={ACCESS_TOKEN}
        onProgress={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(registeredTool("bento_set_customer_lesson_progress")).toBeTruthy());
    await expect(
      executeWithSignal(registeredTool("bento_set_customer_lesson_progress"), aborted.signal, {
        lessonId: LESSON_ONE_ID,
        completed: true,
      }),
    ).rejects.toThrow();
    expect(mocks.setProgress).not.toHaveBeenCalled();
    cleanup();

    render(
      <BookingPortal
        product={baseProduct("coaching_call") as never}
        bookings={[]}
        token={ACCESS_TOKEN}
        now={NOW}
        onBooked={vi.fn()}
        onCanceled={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(mocks.getSlots).toHaveBeenCalled());
    const slotCalls = mocks.getSlots.mock.calls.length;
    await expect(
      executeWithSignal(registeredTool("bento_get_customer_booking_availability"), aborted.signal),
    ).rejects.toThrow();
    await expect(
      executeWithSignal(registeredTool("bento_create_customer_booking"), aborted.signal, {
        startsAt: "2026-09-01T10:00:00.000Z",
        name: "Buyer",
      }),
    ).rejects.toThrow();
    expect(mocks.getSlots).toHaveBeenCalledTimes(slotCalls);
    expect(mocks.createBooking).not.toHaveBeenCalled();
    cleanup();

    const data = accessData();
    render(
      <BookingPortal
        product={baseProduct("coaching_call") as never}
        bookings={data.bookings}
        token={ACCESS_TOKEN}
        now={NOW}
        onBooked={vi.fn()}
        onCanceled={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(registeredTool("bento_cancel_customer_booking")).toBeTruthy());
    await expect(
      executeWithSignal(registeredTool("bento_cancel_customer_booking"), aborted.signal, {
        bookingId: BOOKING_ID,
      }),
    ).rejects.toThrow();
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    cleanup();

    render(
      <CommunityPortal
        product={data.product}
        posts={data.posts}
        comments={data.comments}
        notifications={data.communityNotifications}
        grant={data.grant}
        token={ACCESS_TOKEN}
        onPost={vi.fn()}
        onComment={vi.fn()}
        onPreferences={vi.fn()}
        onNotificationsRead={vi.fn()}
        onModerated={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(registeredTool("bento_moderate_customer_community_content")).toBeTruthy(),
    );
    const communityActions: Array<[string, Record<string, unknown>]> = [
      ["bento_create_customer_community_post", { body: "Hello" }],
      ["bento_create_customer_community_comment", { postId: POST_ID, body: "Reply" }],
      [
        "bento_save_customer_community_preferences",
        { displayName: "Safe member", notificationsEnabled: false },
      ],
      ["bento_mark_customer_community_notifications_read", {}],
      ["bento_moderate_customer_community_content", { kind: "post", contentId: POST_ID }],
    ];
    for (const [name, input] of communityActions) {
      await expect(
        executeWithSignal(registeredTool(name), aborted.signal, input),
      ).rejects.toThrow();
    }

    expect(window.confirm).not.toHaveBeenCalled();
    expect(mocks.createPost).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.savePreferences).not.toHaveBeenCalled();
    expect(mocks.markNotificationsRead).not.toHaveBeenCalled();
    expect(mocks.moderateContent).not.toHaveBeenCalled();
  });

  it("reads availability and creates a booking through the existing mutation callbacks", async () => {
    const slot = {
      startsAt: "2026-09-01T10:00:00.000Z",
      endsAt: "2026-09-01T11:00:00.000Z",
    };
    mocks.getSlots.mockResolvedValue({ slots: [slot] });
    mocks.createBooking.mockResolvedValue({
      id: BOOKING_ID,
      starts_at: slot.startsAt,
      ends_at: slot.endsAt,
      timezone: "UTC",
      meeting_url: `https://meet.example/${ACCESS_TOKEN}`,
      recording_status: null,
      recording_share_url: null,
      status: "confirmed",
    });
    const onBooked = vi.fn();
    render(
      <BookingPortal
        product={baseProduct("coaching_call") as never}
        bookings={[]}
        token={ACCESS_TOKEN}
        now={NOW}
        onBooked={onBooked}
        onCanceled={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(registeredTool("bento_get_customer_booking_availability")).toBeTruthy(),
    );

    const availability = await execute(registeredTool("bento_get_customer_booking_availability"));
    expect(availability).toMatchObject({
      structuredContent: { timezone: "UTC", slots: [slot] },
    });
    const result = await act(async () =>
      execute(registeredTool("bento_create_customer_booking"), {
        startsAt: slot.startsAt,
        name: "Buyer",
        notes: "Please start on time",
      }),
    );

    expect(mocks.createBooking).toHaveBeenCalledWith({
      data: {
        token: ACCESS_TOKEN,
        startsAt: slot.startsAt,
        timezone: "UTC",
        name: "Buyer",
        notes: "Please start on time",
      },
    });
    expect(onBooked).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  it("cancels only a future booking from this portal", async () => {
    const booking = accessData().bookings[0];
    mocks.cancelBooking.mockResolvedValue({ ...booking, status: "canceled" });
    render(
      <BookingPortal
        product={baseProduct("coaching_call") as never}
        bookings={[booking]}
        token={ACCESS_TOKEN}
        now={NOW}
        onBooked={vi.fn()}
        onCanceled={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(registeredTool("bento_cancel_customer_booking")).toBeTruthy());

    const result = await execute(registeredTool("bento_cancel_customer_booking"), {
      bookingId: BOOKING_ID,
    });
    expect(mocks.cancelBooking).toHaveBeenCalledWith({
      data: { token: ACCESS_TOKEN, bookingId: BOOKING_ID },
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  it("routes every community write through confirmation and existing callbacks", async () => {
    const data = accessData();
    const post = data.posts[0];
    const comment = data.comments[0];
    mocks.createPost.mockResolvedValue(post);
    mocks.createComment.mockResolvedValue(comment);
    mocks.savePreferences.mockResolvedValue({
      member_name: "Safe member",
      community_notifications_enabled: false,
    });
    mocks.markNotificationsRead.mockResolvedValue({ marked: 1 });
    mocks.moderateContent.mockResolvedValue({ id: POST_ID, kind: "post", status: "hidden" });
    const callbacks = {
      onPost: vi.fn(),
      onComment: vi.fn(),
      onPreferences: vi.fn(),
      onNotificationsRead: vi.fn(),
      onModerated: vi.fn(),
    };
    render(
      <CommunityPortal
        product={data.product}
        posts={data.posts}
        comments={data.comments}
        notifications={data.communityNotifications}
        grant={data.grant}
        token={ACCESS_TOKEN}
        {...callbacks}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(registeredTool("bento_moderate_customer_community_content")).toBeTruthy(),
    );

    const results: unknown[] = [];
    await act(async () => {
      results.push(
        await execute(registeredTool("bento_create_customer_community_post"), { body: "Hello" }),
        await execute(registeredTool("bento_create_customer_community_comment"), {
          postId: POST_ID,
          body: "Reply",
        }),
        await execute(registeredTool("bento_save_customer_community_preferences"), {
          displayName: "Safe member",
          notificationsEnabled: false,
        }),
        await execute(registeredTool("bento_mark_customer_community_notifications_read")),
        await execute(registeredTool("bento_moderate_customer_community_content"), {
          kind: "post",
          contentId: POST_ID,
        }),
      );
    });

    expect(window.confirm).toHaveBeenCalledTimes(5);
    expect(mocks.createPost).toHaveBeenCalledWith({ data: { token: ACCESS_TOKEN, body: "Hello" } });
    expect(mocks.createComment).toHaveBeenCalledWith({
      data: { token: ACCESS_TOKEN, postId: POST_ID, body: "Reply" },
    });
    expect(mocks.savePreferences).toHaveBeenCalledWith({
      data: { token: ACCESS_TOKEN, displayName: "Safe member", notificationsEnabled: false },
    });
    expect(mocks.markNotificationsRead).toHaveBeenCalledWith({
      data: { token: ACCESS_TOKEN, notificationIds: [NOTIFICATION_ID] },
    });
    expect(mocks.moderateContent).toHaveBeenCalledWith({
      data: { token: ACCESS_TOKEN, kind: "post", contentId: POST_ID, status: "hidden" },
    });
    expect(callbacks.onPost).toHaveBeenCalled();
    expect(callbacks.onComment).toHaveBeenCalled();
    expect(callbacks.onPreferences).toHaveBeenCalledWith("Safe member", false);
    expect(callbacks.onNotificationsRead).toHaveBeenCalledWith([NOTIFICATION_ID]);
    expect(callbacks.onModerated).toHaveBeenCalledWith("post", POST_ID);
    expect(JSON.stringify(results)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(results)).not.toContain("https://");

    const schemas = registerTool.mock.calls
      .map(([tool]) => JSON.stringify((tool as WebMcpTool).inputSchema))
      .join("\n");
    expect(schemas).not.toContain("token");
  });
});
