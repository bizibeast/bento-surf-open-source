import { INSTAGRAM_AUTO_DM_DEFAULTS as autoDmDefaults } from "@/lib/instagram-auto-dm-defaults";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import type { SchedulerConnection, SchedulerPost } from "@/lib/social-scheduler";
import { xAccountCapabilities } from "@/lib/x-account";
import { uploadFileResult } from "@/lib/upload";
import { prepareSchedulerVideoUpload } from "@/lib/video-upload";
import {
  cancelSocialPost,
  deleteSocialPost,
  getRedditCommunities,
  getSocialScheduler,
  getSocialDraftById,
  moveSocialPostToDraft,
  rescheduleSocialPost,
  retryFailedSocialPost,
  savePostingSchedule,
  saveSocialPost,
} from "@/lib/social-scheduler.functions";
import { searchSocialMentions } from "@/lib/social-mentions.functions";

const deepLink = vi.hoisted(() => ({ postId: undefined as string | undefined }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => deepLink,
  }),
  Link: ({
    to,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/social-scheduler.functions", () => ({
  cancelSocialPost: vi.fn(),
  deleteSocialPost: vi.fn(),
  duplicateSocialPost: vi.fn(),
  getRedditCommunities: vi.fn(),
  getSocialScheduler: vi.fn(),
  getSocialDraftById: vi.fn(),
  getTikTokCreatorInfo: vi.fn(),
  moveSocialPostToDraft: vi.fn(),
  refreshSocialConnectionAvatar: vi.fn(),
  rescheduleSocialPost: vi.fn(),
  retryFailedSocialPost: vi.fn(),
  savePostingSchedule: vi.fn(),
  saveSocialPost: vi.fn(),
}));

vi.mock("@/lib/social-mentions.functions", () => ({ searchSocialMentions: vi.fn() }));
vi.mock("@/lib/scheduler-assist.functions", () => ({
  getSchedulerPhotoLibrary: vi.fn(async () => ({
    photos: [],
    cursor: null,
    stockAvailable: true,
    stockProvider: "commons",
    stockProviders: ["commons"],
  })),
  findSchedulerStockPhotos: vi.fn(),
  addSchedulerStockPhoto: vi.fn(),
  getSchedulerImageSettings: vi.fn(),
  generateSchedulerImage: vi.fn(),
  getSchedulerImageJob: vi.fn(),
  rewriteSchedulerText: vi.fn(),
}));

vi.mock("@/lib/upload", () => ({ uploadFileResult: vi.fn() }));
vi.mock("@/lib/video-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/video-upload")>()),
  prepareSchedulerVideoUpload: vi.fn(async (file: File) => file),
}));

import {
  captureVideoFrame,
  createAvatarRepairHandler,
  createSchedulerWebMcpTools,
  Route,
  SchedulerStatusLine,
  schedulerComposeFingerprint,
  VideoCoverFramePicker,
} from "./post-scheduler";

const SchedulerPage = (Route as unknown as { component: ComponentType }).component;

const missingAvatar: SchedulerConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "instagram",
  handle: "bizibeast",
  displayName: "Bizibeast",
  avatarUrl: null,
  status: "active",
  connectedAt: "2026-08-24T00:00:00.000Z",
  canPublish: true,
  publishBlockReason: null,
};

const schedulerData = {
  locked: false,
  plan: "creator" as const,
  connections: [{ ...missingAvatar, avatarUrl: "https://bento.surf/avatar.png" }],
  posts: [],
  providers: [],
  readiness: {},
  postingSchedule: { timezone: "UTC", slots: [], naturalOffset: false },
};

function renderScheduler(data: unknown = schedulerData) {
  vi.mocked(getSocialScheduler).mockResolvedValue(data as never);
  vi.mocked(saveSocialPost).mockResolvedValue(schedulerData as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SchedulerPage />
    </QueryClientProvider>,
  );
}

describe("publishing calendar slots", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const slots = Array.from({ length: 7 }, (_, day) =>
    ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"].map(
      (time) => ({
        day,
        time,
      }),
    ),
  ).flat();

  it.each(["week", "month"] as const)(
    "places an 8:57 post inside the 9 AM slot in %s view without changing its timestamp",
    async (view) => {
      const date = new Date().toISOString().slice(0, 10);
      const post = {
        id: "11111111-1111-4111-8111-111111111112",
        status: "scheduled",
        title: "Naturally timed post",
        body: "Still publishing at 8:57",
        scheduledAt: `${date}T08:57:00.000Z`,
        createdAt: new Date().toISOString(),
        timezone: "UTC",
        targets: [],
        media: [],
      } as SchedulerPost;
      renderScheduler({
        ...schedulerData,
        posts: [post],
        postingSchedule: { timezone: "UTC", slots, naturalOffset: true },
      });
      await screen.findByRole("heading", { name: "Drafts" });
      if (view === "month") fireEvent.click(screen.getByRole("button", { name: "month" }));
      const calendar = screen.getByRole("grid", { name: `${view} publishing calendar` });
      const day = within(calendar)
        .getAllByRole("gridcell")
        .find((cell) => within(cell).queryByText(post.title!))!;
      const slot = within(day).getByRole("button", { name: "9:00 AM" }).parentElement!;
      expect(within(slot).getByText(post.title!)).toBeVisible();
      expect(within(slot).getByText("8:57 AM")).toBeVisible();
      expect(within(slot).getByText("Drop another post")).toBeVisible();
      expect(within(calendar).getAllByText(post.title!)).toHaveLength(1);
      expect(saveSocialPost).not.toHaveBeenCalled();
      expect(post.scheduledAt).toBe(`${date}T08:57:00.000Z`);
    },
  );

  it("expands every slot on one day and keeps the extra slots available for draft drops", async () => {
    const draft = {
      id: "11111111-1111-4111-8111-111111111112",
      status: "draft",
      title: "Draft ready",
      body: "Schedule me",
      scheduledAt: null,
      createdAt: new Date().toISOString(),
      timezone: "UTC",
      targets: [],
      media: [],
    } as SchedulerPost;
    renderScheduler({
      ...schedulerData,
      posts: [draft],
      postingSchedule: { timezone: "UTC", slots, naturalOffset: false },
    });

    await screen.findByRole("heading", { name: "Drafts" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const calendar = screen.getByRole("grid", { name: "week publishing calendar" });
    const firstDay = within(calendar).getAllByRole("gridcell")[0];
    const secondDay = within(calendar).getAllByRole("gridcell")[1];
    const expand = within(firstDay).getByRole("button", { name: /Show 5 more slots on/i });

    expect(within(firstDay).getAllByText("Drop post here")).toHaveLength(4);
    fireEvent.click(expand);
    expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(within(firstDay).getAllByText("Drop post here")).toHaveLength(9);
    expect(within(secondDay).getAllByText("Drop post here")).toHaveLength(4);

    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      data: new Map<string, string>(),
      setData(type: string, value: string) {
        this.data.set(type, value);
      },
      getData(type: string) {
        return this.data.get(type) || "";
      },
    };
    const draftCard = screen.getByText("Draft ready").closest("article")!;
    expect(draftCard).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(draftCard, { dataTransfer: transfer });
    expect(transfer.getData("application/x-bento-social-post-id")).toBe(draft.id);
    const lastSlot = within(firstDay).getByRole("button", { name: "5:00 PM" });
    fireEvent.dragOver(lastSlot, { dataTransfer: transfer });
    fireEvent.drop(lastSlot, { dataTransfer: transfer });

    await waitFor(() =>
      expect(rescheduleSocialPost).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: draft.id,
          scheduledAt: expect.stringMatching(/T17:00:00\.000Z$/),
          timezone: "UTC",
        }),
      }),
    );

    fireEvent.click(expand);
    expect(within(firstDay).getAllByText("Drop post here")).toHaveLength(4);
  });

  it("reveals all slots in month view as well", async () => {
    renderScheduler({
      ...schedulerData,
      postingSchedule: { timezone: "UTC", slots, naturalOffset: false },
    });
    await screen.findByRole("button", { name: "Next week" });
    fireEvent.click(screen.getByRole("button", { name: "month" }));
    const firstDay = within(
      screen.getByRole("grid", { name: "month publishing calendar" }),
    ).getAllByRole("gridcell")[0];
    expect(within(firstDay).getAllByText("Drop post here")).toHaveLength(2);
    fireEvent.click(within(firstDay).getByRole("button", { name: /Show 7 more slots on/i }));
    expect(within(firstDay).getAllByText("Drop post here")).toHaveLength(9);
  });
});

describe("scheduler post moves and deletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const scheduledPost = () => ({
    id: "11111111-1111-4111-8111-111111111113",
    status: "scheduled" as const,
    title: "Return to drafts",
    body: "A post to move",
    scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    targets: [],
    media: [],
  });

  it.each(["failed", "partially_failed"] as const)(
    "retries failed destinations from a %s post",
    async (status) => {
      const post = {
        ...scheduledPost(),
        status,
        title: `Retry ${status}`,
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        targets: [
          {
            id: "11111111-1111-4111-8111-111111111114",
            connectionId: missingAvatar.id,
            provider: "instagram" as const,
            status: "failed" as const,
            remotePostUrl: null,
            errorMessage: "Publishing failed",
            publishedAt: null,
          },
          ...(status === "partially_failed"
            ? [
                {
                  id: "11111111-1111-4111-8111-111111111115",
                  connectionId: "11111111-1111-4111-8111-111111111116",
                  provider: "facebook" as const,
                  status: "published" as const,
                  remotePostUrl: "https://example.com/post",
                  errorMessage: null,
                  publishedAt: new Date().toISOString(),
                },
              ]
            : []),
        ],
      } as SchedulerPost;
      const data = { ...schedulerData, posts: [post] };
      vi.mocked(retryFailedSocialPost).mockResolvedValue({
        ...data,
        posts: [{ ...post, status: "publishing" }],
      } as never);
      renderScheduler(data);

      const retryButton = await screen.findByRole("button", {
        name: "Retry failed destinations",
      });
      const card = retryButton.closest("article")!;
      fireEvent.click(retryButton);

      await waitFor(() =>
        expect(retryFailedSocialPost).toHaveBeenCalledWith({ data: { id: post.id } }),
      );
      await waitFor(() => expect(within(card).getByText("publishing")).toBeVisible());
    },
  );

  it("opens an existing draft for editing and saves changes to the same post", async () => {
    const draft = {
      ...scheduledPost(),
      status: "draft" as const,
      title: "Draft title",
      body: "Original caption",
      scheduledAt: null,
    };
    renderScheduler({ ...schedulerData, posts: [draft] });
    const drafts = await screen.findByRole("region", { name: "Drafts drop area" });

    fireEvent.click(within(drafts).getByRole("button", { name: "Edit draft" }));
    const compose = await screen.findByRole("dialog", { name: "Edit post" });
    expect(within(compose).getByRole("textbox", { name: /Post text/i })).toHaveValue(
      "Original caption",
    );

    fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/i }), {
      target: { value: "Updated caption" },
    });
    await waitFor(
      () =>
        expect(saveSocialPost).toHaveBeenCalledWith({
          data: expect.objectContaining({
            id: draft.id,
            body: "Updated caption",
            asDraft: true,
          }),
        }),
      { timeout: 3_000 },
    );
  });

  it("moves a calendar post into the Drafts area when dropped", async () => {
    const post = scheduledPost();
    const data = { ...schedulerData, posts: [post] };
    const moved = {
      ...data,
      posts: [{ ...post, status: "draft", scheduledAt: null }],
    };
    let resolveMove!: (value: typeof moved) => void;
    vi.mocked(moveSocialPostToDraft).mockReturnValue(
      new Promise((resolve) => {
        resolveMove = resolve;
      }) as never,
    );
    renderScheduler(data);
    await screen.findByRole("heading", { name: "Drafts" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const calendar = screen.getByRole("grid", { name: "week publishing calendar" });
    const calendarPost = within(calendar).getByText(post.title).closest("button")!;
    const draftsArea = screen.getByRole("region", { name: "Drafts drop area" });
    const transfer = {
      types: ["application/x-bento-social-post-id", "text/plain"],
      effectAllowed: "none",
      dropEffect: "none",
      data: new Map<string, string>(),
      setData(type: string, value: string) {
        this.data.set(type, value);
      },
      getData(type: string) {
        return this.data.get(type) || "";
      },
    };

    fireEvent.dragStart(calendarPost, { dataTransfer: transfer });
    fireEvent.dragEnter(draftsArea, { dataTransfer: transfer });
    fireEvent.dragOver(draftsArea, { dataTransfer: transfer });
    expect(draftsArea).toHaveClass("ring-2");
    fireEvent.drop(draftsArea, { dataTransfer: transfer });

    await waitFor(() =>
      expect(moveSocialPostToDraft).toHaveBeenCalledWith({ data: { id: post.id } }),
    );
    await waitFor(() => expect(within(draftsArea).getByText(post.title)).toBeVisible());
    expect(within(calendar).queryByText(post.title)).not.toBeInTheDocument();
    resolveMove(moved);
  });

  it("shows a draft on the calendar before the reschedule request finishes", async () => {
    const draft = {
      ...scheduledPost(),
      status: "draft" as const,
      title: "Schedule instantly",
      scheduledAt: null,
    };
    const data = { ...schedulerData, posts: [draft] };
    let resolveMove!: (value: unknown) => void;
    vi.mocked(rescheduleSocialPost).mockReturnValue(
      new Promise((resolve) => {
        resolveMove = resolve;
      }) as never,
    );
    renderScheduler(data);
    const draftsArea = await screen.findByRole("region", { name: "Drafts drop area" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const calendar = screen.getByRole("grid", { name: "week publishing calendar" });
    const firstDay = within(calendar).getAllByRole("gridcell")[0];
    const transfer = {
      getData: () => draft.id,
      dropEffect: "none",
    };

    fireEvent.drop(firstDay, { dataTransfer: transfer });

    await waitFor(() => expect(within(firstDay).getByText(draft.title)).toBeVisible());
    expect(within(draftsArea).queryByText(draft.title)).not.toBeInTheDocument();
    const scheduledAt = (
      vi.mocked(rescheduleSocialPost).mock.calls[0]![0] as { data: { scheduledAt: string } }
    ).data.scheduledAt;
    resolveMove({ ...data, posts: [{ ...draft, status: "scheduled", scheduledAt }] });
  });

  it("restores a calendar post if moving it to drafts fails", async () => {
    const post = scheduledPost();
    let rejectMove!: (error: Error) => void;
    vi.mocked(moveSocialPostToDraft).mockReturnValue(
      new Promise((_, reject) => {
        rejectMove = reject;
      }) as never,
    );
    renderScheduler({ ...schedulerData, posts: [post] });
    await screen.findByRole("heading", { name: "Drafts" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const calendar = screen.getByRole("grid", { name: "week publishing calendar" });
    const draftsArea = screen.getByRole("region", { name: "Drafts drop area" });

    fireEvent.drop(draftsArea, { dataTransfer: { getData: () => post.id } });
    await waitFor(() => expect(within(draftsArea).getByText(post.title)).toBeVisible());
    rejectMove(new Error("Save failed"));

    await waitFor(() => expect(within(calendar).getByText(post.title)).toBeVisible());
    expect(within(draftsArea).queryByText(post.title)).not.toBeInTheDocument();
  });

  it("asks for confirmation before deleting a calendar post", async () => {
    const post = scheduledPost();
    const confirm = vi.spyOn(window, "confirm");
    const data = { ...schedulerData, posts: [post] };
    vi.mocked(deleteSocialPost).mockResolvedValue({ ...data, posts: [] } as never);
    renderScheduler(data);
    await screen.findByRole("heading", { name: "Drafts" });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    const calendarPost = within(screen.getByRole("grid", { name: "week publishing calendar" }))
      .getByText(post.title)
      .closest("button")!;

    fireEvent.contextMenu(calendarPost);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this post?" });
    expect(within(dialog).getByText(/Are you sure you want to delete this post/)).toBeVisible();
    expect(deleteSocialPost).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep post" }));
    expect(screen.queryByRole("alertdialog", { name: "Delete this post?" })).toBeNull();

    fireEvent.contextMenu(calendarPost);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Delete this post?" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    await waitFor(() => expect(deleteSocialPost).toHaveBeenCalledWith({ data: { id: post.id } }));
  });
});

describe("scheduler compose close protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  it("fingerprints meaningful compose changes", () => {
    const base = {
      body: "",
      title: "",
      scheduledAt: "2026-09-21T12:00",
      selected: [],
      media: [],
      providerSettings: {},
    };

    expect(schedulerComposeFingerprint(base)).toBe(schedulerComposeFingerprint({ ...base }));
    expect(schedulerComposeFingerprint({ ...base, body: "Changed" })).not.toBe(
      schedulerComposeFingerprint(base),
    );
  });

  it("opens the Create a post dialog from the header button", async () => {
    renderScheduler();
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    expect(compose).toBeVisible();
    expect(within(compose).getByRole("textbox")).toHaveValue("");
  });

  it("saves independent repost settings in the X and LinkedIn tabs", async () => {
    renderScheduler({
      ...schedulerData,
      connections: [
        {
          ...missingAvatar,
          id: "11111111-1111-4111-8111-111111111121",
          provider: "twitter",
          displayName: "X account",
          avatarUrl: "https://bento.surf/x-avatar.png",
        },
        {
          ...missingAvatar,
          id: "11111111-1111-4111-8111-111111111122",
          provider: "linkedin",
          displayName: "LinkedIn account",
          avatarUrl: "https://bento.surf/linkedin-avatar.png",
        },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /X account/i }));
    fireEvent.click(within(compose).getByRole("button", { name: /LinkedIn account/i }));
    fireEvent.click(within(compose).getByRole("button", { name: "Edit X: X account" }));
    fireEvent.change(within(compose).getByRole("textbox"), {
      target: { value: "Native repost test" },
    });
    fireEvent.click(within(compose).getByRole("checkbox", { name: /Auto-repost on/i }));
    fireEvent.click(within(compose).getByRole("checkbox", { name: "Remove the repost later" }));
    fireEvent.click(
      within(compose).getByRole("button", { name: "Edit LinkedIn: LinkedIn account" }),
    );
    expect(
      within(compose).getByRole("checkbox", { name: "Auto-repost on LinkedIn" }),
    ).not.toBeChecked();
    expect(
      within(compose).queryByRole("checkbox", { name: "Auto-repost on X" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(compose).getByRole("checkbox", { name: "Auto-repost on LinkedIn" }));
    fireEvent.change(within(compose).getByLabelText("Repost after (hours)"), {
      target: { value: "72" },
    });
    await waitFor(
      () =>
        expect(saveSocialPost).toHaveBeenCalledWith({
          data: expect.objectContaining({
            providerSettings: expect.objectContaining({
              twitter: expect.objectContaining({
                autoRepost: { afterHours: 24, removeAfterHours: 48 },
              }),
              linkedin: expect.objectContaining({
                autoRepost: { afterHours: 72, removeAfterHours: null },
              }),
            }),
          }),
        }),
      { timeout: 3_000 },
    );
  });

  it("offers X Articles for an eligible connected account", async () => {
    renderScheduler({
      ...schedulerData,
      connections: [
        {
          ...schedulerData.connections[0],
          provider: "twitter",
          xCapabilities: xAccountCapabilities("Premium", "blue"),
        },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /Bizibeast/i }));
    expect(within(compose).getByText(/25,000 characters/)).toBeVisible();
    fireEvent.click(within(compose).getByRole("button", { name: "Article" }));
    fireEvent.change(within(compose).getByRole("textbox", { name: /Article title/i }), {
      target: { value: "A closer look" },
    });
    fireEvent.change(within(compose).getByRole("textbox", { name: /Article body/i }), {
      target: { value: "First paragraph\n\nSecond paragraph" },
    });
    expect(within(compose).getByRole("button", { name: "Add media" })).toBeDisabled();
    const preview = within(compose).getByTestId("x-article-preview-scroll");
    expect(preview).toHaveClass("overflow-y-auto");
    const reader = within(preview).getByLabelText("X Article reader preview");
    expect(within(reader).getByText("Article")).toBeVisible();
    expect(within(reader).getByText("@bizibeast")).toBeVisible();
    expect(within(reader).getByText("A closer look")).toBeVisible();
    expect(within(reader).getByText("First paragraph")).toBeVisible();
    expect(within(reader).getByText("Second paragraph")).toBeVisible();
    fireEvent.click(within(compose).getByRole("button", { name: "Embed X post" }));
    fireEvent.change(within(compose).getByRole("textbox", { name: "X post URL for section 2" }), {
      target: { value: "https://x.com/creator/status/123456789" },
    });
    expect(within(reader).getByTitle("Embedded X post 2")).toHaveAttribute(
      "src",
      expect.stringContaining("id=123456789"),
    );
    expect(within(compose).getByRole("button", { name: "Inline image" })).toBeEnabled();
    expect(within(compose).getByRole("button", { name: "Add cover" })).toBeEnabled();
    vi.mocked(uploadFileResult)
      .mockResolvedValueOnce({
        key: "users/creator/image/cover.jpg",
        publicUrl: "https://bento.surf/cdn/users/creator/image/cover.jpg",
        size: 100,
        name: "cover.jpg",
        mimeType: "image/jpeg",
      })
      .mockResolvedValueOnce({
        key: "users/creator/image/inline.jpg",
        publicUrl: "https://bento.surf/cdn/users/creator/image/inline.jpg",
        size: 100,
        name: "inline.jpg",
        mimeType: "image/jpeg",
      });
    fireEvent.change(within(compose).getByLabelText("Upload Article cover"), {
      target: { files: [new File(["cover"], "cover.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() =>
      expect(within(reader).getByAltText("Article cover")).toHaveAttribute(
        "src",
        expect.stringContaining("cover.jpg"),
      ),
    );
    fireEvent.change(within(compose).getByLabelText("Upload inline Article image"), {
      target: { files: [new File(["inline"], "inline.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(within(reader).getByAltText("inline.jpg")).toBeVisible());
    expect(
      within(preview).getByText(/X may render the published Article differently/),
    ).toBeVisible();
    await waitFor(() => expect(saveSocialPost).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() =>
      expect(saveSocialPost).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerSettings: expect.objectContaining({
              twitter: expect.objectContaining({
                kind: "article",
                article: expect.objectContaining({
                  cover: expect.objectContaining({ name: "cover.jpg" }),
                  blocks: expect.arrayContaining([
                    expect.objectContaining({ kind: "image" }),
                    expect.objectContaining({ kind: "post" }),
                  ]),
                }),
              }),
            }),
          }),
        }),
      ),
    );
  });

  it("scrolls the composer and preview independently without scaling the post", async () => {
    renderScheduler();
    const create = await screen.findAllByRole("button", { name: /Create post on/i });
    fireEvent.click(create[0]);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });

    expect(
      within(compose).queryByText(/Write once, preview every channel/i),
    ).not.toBeInTheDocument();
    expect(within(compose).getByTestId("scheduler-compose-scroll")).toHaveClass(
      "lg:overflow-y-auto",
    );
    expect(within(compose).getByTestId("scheduler-preview-pane")).toHaveClass("overflow-hidden");
    const previewScroll = within(compose).getByTestId("scheduler-preview-scroll");
    expect(previewScroll).toHaveClass("overflow-y-auto");
    expect(previewScroll.querySelector('[style*="scale("]')).toBeNull();
    expect(within(compose).queryByText(/^Live preview$/i)).not.toBeInTheDocument();
    expect(within(compose).queryByText(/Platform chrome and truncation/i)).not.toBeInTheDocument();
  });

  it("schedules the next open posting slot from the footer arrow", async () => {
    const first = new Date(Date.now() + 3 * 60 * 60_000);
    first.setUTCMinutes(0, 0, 0);
    const second = new Date(first.getTime() + 60 * 60_000);
    const connection = {
      ...missingAvatar,
      id: "linkedin",
      provider: "linkedin" as const,
      displayName: "LinkedIn account",
      avatarUrl: "https://bento.surf/avatar.png",
    };
    renderScheduler({
      ...schedulerData,
      connections: [connection],
      posts: [
        {
          id: "occupied",
          status: "scheduled",
          body: "Already scheduled",
          title: null,
          scheduledAt: first.toISOString(),
          createdAt: new Date().toISOString(),
          timezone: "UTC",
          targets: [],
          media: [],
        } as SchedulerPost,
      ],
      postingSchedule: {
        timezone: "UTC",
        slots: [first, second].map((date) => ({
          day: date.getUTCDay(),
          time: date.toISOString().slice(11, 16),
        })),
        naturalOffset: false,
      },
    });

    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "LinkedIn: LinkedIn account" }));
    fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/i }), {
      target: { value: "Next slot please" },
    });
    fireEvent.click(
      within(compose).getByRole("button", { name: "Schedule at the next posting slot" }),
    );

    await waitFor(() =>
      expect(saveSocialPost).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scheduledAt: second.toISOString(),
          connectionIds: [connection.id],
          publishNow: false,
          asDraft: false,
        }),
      }),
    );
  });

  it("keeps long posts scrollable when switching between network previews", async () => {
    const networks = [
      ["twitter", "X"],
      ["threads", "Threads"],
      ["linkedin", "LinkedIn"],
      ["facebook", "Facebook"],
      ["instagram", "Instagram"],
      ["reddit", "Reddit"],
    ] as const;
    const connections = networks.map(([provider]) => ({
      ...missingAvatar,
      id: provider,
      provider,
      displayName: `${provider} account`,
      avatarUrl: "https://bento.surf/avatar.png",
    }));
    vi.mocked(getRedditCommunities).mockResolvedValue([] as never);
    renderScheduler({ ...schedulerData, connections });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    for (const connection of connections) {
      fireEvent.click(
        within(compose).getByRole("button", { name: new RegExp(connection.displayName) }),
      );
    }

    const longPost = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}`).join(
      "\n\n",
    );
    fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
    fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/i }), {
      target: { value: longPost },
    });
    expect(within(compose).getByRole("switch", { name: "Sync" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const previewScroll = within(compose).getByTestId("scheduler-preview-scroll");
    for (const [provider, label] of networks) {
      fireEvent.click(
        within(compose).getByRole("button", { name: `Edit ${label}: ${provider} account` }),
      );
      expect(previewScroll).toHaveClass("overflow-y-auto");
      if (provider === "reddit") expect(previewScroll).toHaveTextContent("Paragraph 30");
      else expect(previewScroll).not.toHaveTextContent("Paragraph 30");
      expect(previewScroll.querySelector('[style*="scale("]')).toBeNull();
    }
  });

  it("keeps copy synchronized until Sync is explicitly disabled", async () => {
    const connections = [
      {
        ...missingAvatar,
        id: "linkedin",
        provider: "linkedin" as const,
        displayName: "LinkedIn account",
        avatarUrl: "https://bento.surf/avatar.png",
      },
      {
        ...missingAvatar,
        id: "twitter",
        provider: "twitter" as const,
        displayName: "X account",
        avatarUrl: "https://bento.surf/avatar.png",
      },
    ];
    renderScheduler({ ...schedulerData, connections });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "LinkedIn: LinkedIn account" }));
    fireEvent.click(within(compose).getByRole("button", { name: "X: X account" }));
    expect(within(compose).queryByRole("button", { name: "All networks" })).toBeNull();
    expect(within(compose).getByText("X format")).toBeVisible();
    fireEvent.click(
      within(compose).getByRole("button", { name: "Edit LinkedIn: LinkedIn account" }),
    );
    expect(within(compose).queryByText("X format")).not.toBeInTheDocument();
    expect(within(compose).getByRole("switch", { name: "Sync" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/i }), {
      target: { value: "LinkedIn version" },
    });
    expect(within(compose).getByRole("switch", { name: "Sync" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(compose).getByRole("button", { name: "Edit X: X account" }));
    expect(within(compose).getByText("X format")).toBeVisible();
    expect(within(compose).getByRole("textbox")).toHaveValue("LinkedIn version");
    fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
    fireEvent.change(within(compose).getByRole("textbox"), { target: { value: "X version" } });
    fireEvent.click(
      within(compose).getByRole("button", { name: "Edit LinkedIn: LinkedIn account" }),
    );
    expect(within(compose).getByRole("textbox")).toHaveValue("LinkedIn version");

    // Removing the active account must select a remaining destination, not leave a
    // hidden shared-text editor that can overwrite its customized copy.
    fireEvent.click(within(compose).getByRole("button", { name: "LinkedIn: LinkedIn account" }));
    expect(within(compose).getByRole("button", { name: "Edit X: X account" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(compose).getByRole("textbox")).toHaveValue("X version");
    fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
    fireEvent.click(within(compose).getByRole("button", { name: "LinkedIn: LinkedIn account" }));
    expect(within(compose).getByRole("textbox")).toHaveValue("X version");
    expect(within(compose).getByRole("switch", { name: "Sync" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("selects a Facebook Page mention without changing the X copy", async () => {
    vi.mocked(searchSocialMentions).mockResolvedValue({
      provider: "facebook",
      items: [
        {
          provider: "facebook",
          id: "12345",
          name: "Acme Studio",
          handle: null,
          kind: "page",
          verified: true,
        },
      ],
      detail: null,
    });
    const connections = [
      {
        ...missingAvatar,
        id: "facebook",
        provider: "facebook" as const,
        displayName: "Facebook account",
        avatarUrl: "https://bento.surf/avatar.png",
      },
      {
        ...missingAvatar,
        id: "twitter",
        provider: "twitter" as const,
        displayName: "X account",
        avatarUrl: "https://bento.surf/avatar.png",
      },
    ];
    renderScheduler({ ...schedulerData, connections });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "Facebook: Facebook account" }));
    fireEvent.click(within(compose).getByRole("button", { name: "X: X account" }));
    fireEvent.click(
      within(compose).getByRole("button", { name: "Edit Facebook: Facebook account" }),
    );
    fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/i }), {
      target: { value: "Working with @Acm" },
    });
    const found = await within(compose).findByRole("option", { name: /Acme Studio/ });
    fireEvent.click(found);
    expect(within(compose).getByRole("textbox", { name: /Post text/i })).toHaveValue(
      "Working with @Acme Studio",
    );
    expect(within(compose).getByRole("switch", { name: "Sync" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.click(within(compose).getByRole("button", { name: "Edit X: X account" }));
    expect(within(compose).getByRole("textbox")).toHaveValue("Working with @Acm");
    await waitFor(() => expect(saveSocialPost).toHaveBeenCalled(), { timeout: 4_000 });
    const saved = vi.mocked(saveSocialPost).mock.calls.at(-1)?.[0] as {
      data: {
        providerSettings: Record<string, Record<string, unknown>>;
        connectionOverrides: Record<string, Record<string, unknown>>;
      };
    };
    expect(saved.data.connectionOverrides.facebook.mentions).toMatchObject([
      { id: "12345", name: "Acme Studio", text: "@Acme Studio", provider: "facebook" },
    ]);
    expect(saved.data.connectionOverrides.twitter.bodyOverride).toBe("Working with @Acm");
  });

  it("shows X account suggestions after three letters, including when the platform is selected later", async () => {
    vi.mocked(searchSocialMentions).mockResolvedValue({
      provider: "twitter",
      items: [
        {
          provider: "twitter",
          id: "42",
          name: "Y Combinator",
          handle: "ycombinator",
          kind: "person",
          verified: true,
        },
      ],
      detail: null,
    });
    renderScheduler({
      ...schedulerData,
      connections: [
        {
          ...missingAvatar,
          provider: "twitter",
          displayName: "X account",
          avatarUrl: "https://bento.surf/avatar.png",
        },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    const editor = within(compose).getByRole("textbox", { name: /Post text/i });
    fireEvent.change(editor, { target: { value: "@yc", selectionStart: 3, selectionEnd: 3 } });
    const listbox = within(compose).getByRole("listbox", { name: "Accounts to mention" });
    expect(listbox).toBeVisible();
    expect(listbox.parentElement).toBe(compose);
    expect(within(compose).getByText("Select a platform above to find accounts")).toBeVisible();
    fireEvent.click(within(compose).getByRole("button", { name: "X: X account" }));
    expect(within(compose).getByText("Type at least 3 letters to search")).toBeVisible();
    expect(searchSocialMentions).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "@yco", selectionStart: 4, selectionEnd: 4 } });
    const found = await within(compose).findByRole("option", { name: /Y Combinator/ });
    await waitFor(() =>
      expect(searchSocialMentions).toHaveBeenCalledWith({
        data: { connectionId: missingAvatar.id, query: "yco" },
      }),
    );
    fireEvent.click(found);
    expect(editor).toHaveValue("@ycombinator");
  });

  it("shows the handle and source for a suggestion from indexed posts", async () => {
    vi.mocked(searchSocialMentions).mockResolvedValue({
      provider: "twitter",
      items: [
        {
          provider: "twitter",
          id: "ycombinator",
          name: "ycombinator",
          handle: "ycombinator",
          kind: "handle",
          verified: false,
          detail: "Seen in your past posts. Check the account before publishing.",
        },
      ],
      detail: null,
    });
    renderScheduler({
      ...schedulerData,
      connections: [
        {
          ...missingAvatar,
          provider: "twitter",
          displayName: "X account",
          avatarUrl: "https://bento.surf/avatar.png",
        },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "X: X account" }));
    fireEvent.change(within(compose).getByRole("textbox"), {
      target: { value: "@yco", selectionStart: 4, selectionEnd: 4 },
    });

    const found = await within(compose).findByRole("option", { name: /ycombinator/ });
    expect(within(found).getByText("@ycombinator")).toBeVisible();
    expect(within(found).getByText(/Seen in your past posts/)).toBeVisible();
  });

  it("keeps a manual text option while platform lookup is loading", async () => {
    vi.mocked(searchSocialMentions).mockImplementation(() => new Promise(() => undefined));
    renderScheduler({
      ...schedulerData,
      connections: [
        {
          ...missingAvatar,
          provider: "twitter",
          displayName: "X account",
          avatarUrl: "https://bento.surf/avatar.png",
        },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "X: X account" }));
    fireEvent.change(within(compose).getByRole("textbox"), {
      target: { value: "@yco", selectionStart: 4, selectionEnd: 4 },
    });

    expect(await within(compose).findByRole("option", { name: /@yco/ })).toBeVisible();
    expect(within(compose).getByText("Looking up accounts…")).toBeVisible();
  });

  it("shows video settings only for the active platform", async () => {
    vi.mocked(uploadFileResult).mockResolvedValue({
      key: "users/creator/video/post.mp4",
      publicUrl: "https://bento.surf/cdn/users/creator/video/post.mp4",
      size: 2_000,
      name: "post.mp4",
      mimeType: "video/mp4",
    });
    const connections = [
      {
        ...missingAvatar,
        id: "instagram",
        provider: "instagram" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
      {
        ...missingAvatar,
        id: "youtube",
        provider: "youtube" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
    ];
    renderScheduler({ ...schedulerData, connections });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "Instagram: Bizibeast" }));
    fireEvent.click(within(compose).getByRole("button", { name: "YouTube: Bizibeast" }));
    fireEvent.change(document.querySelector('input[type="file"][accept*="video"]')!, {
      target: { files: [new File(["video"], "post.mp4", { type: "video/mp4" })] },
    });
    await within(compose).findByText("Thumbnails");
    expect(
      within(compose).getByText(/Reading this video|Custom thumbnail and visibility/),
    ).toBeVisible();
    expect(within(compose).queryByText(/Choose Trial Reel delivery/)).not.toBeInTheDocument();
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    expect(within(compose).getByText(/Choose Trial Reel delivery/)).toBeVisible();
    expect(
      within(compose).queryByText(/Reading this video|Custom thumbnail and visibility/),
    ).not.toBeInTheDocument();
  });

  it("syncs Instagram caption into the YouTube title and keeps one separate description", async () => {
    const connections = [
      {
        ...missingAvatar,
        id: "instagram",
        provider: "instagram" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
      {
        ...missingAvatar,
        id: "youtube",
        provider: "youtube" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
    ];
    renderScheduler({ ...schedulerData, connections });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "Instagram: Bizibeast" }));
    fireEvent.click(within(compose).getByRole("button", { name: "YouTube: Bizibeast" }));
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    fireEvent.change(within(compose).getByRole("textbox", { name: /Caption/i }), {
      target: { value: "My Reel caption" },
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Edit YouTube: Bizibeast" }));
    expect(within(compose).getByRole("textbox", { name: /YouTube title/i })).toHaveValue(
      "My Reel caption",
    );
    expect(within(compose).getAllByRole("textbox", { name: /Description/i })).toHaveLength(1);
    expect(within(compose).getByRole("textbox", { name: /Description/i })).toHaveValue("");
    fireEvent.change(within(compose).getByRole("textbox", { name: /Description/i }), {
      target: { value: "YouTube details" },
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    expect(within(compose).getByRole("textbox", { name: /Caption/i })).toHaveValue(
      "My Reel caption",
    );
  });

  it("lets the YouTube title lead synced captions and turn Sync back on from YouTube", async () => {
    const connections = [
      {
        ...missingAvatar,
        id: "instagram",
        provider: "instagram" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
      {
        ...missingAvatar,
        id: "youtube",
        provider: "youtube" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
    ];
    renderScheduler({ ...schedulerData, connections });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "Instagram: Bizibeast" }));
    fireEvent.click(within(compose).getByRole("button", { name: "YouTube: Bizibeast" }));
    fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
    fireEvent.click(within(compose).getByRole("button", { name: "Edit YouTube: Bizibeast" }));
    const youtubeTitle = within(compose).getByRole("textbox", { name: /YouTube title/i });
    fireEvent.change(youtubeTitle, { target: { value: "Old YouTube title" } });
    fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    fireEvent.change(within(compose).getByRole("textbox", { name: /Caption/i }), {
      target: { value: "Updated Instagram caption" },
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Edit YouTube: Bizibeast" }));
    expect(within(compose).getByRole("textbox", { name: /YouTube title/i })).toHaveValue(
      "Updated Instagram caption",
    );
    fireEvent.change(within(compose).getByRole("textbox", { name: /YouTube title/i }), {
      target: { value: "YouTube leads the copy" },
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    expect(within(compose).getByRole("textbox", { name: /Caption/i })).toHaveValue(
      "YouTube leads the copy",
    );
    fireEvent.click(within(compose).getByRole("button", { name: "Edit YouTube: Bizibeast" }));
    fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
    expect(within(compose).getByRole("textbox", { name: /YouTube title/i })).toHaveValue(
      "YouTube leads the copy",
    );
    fireEvent.change(within(compose).getByRole("textbox", { name: /YouTube title/i }), {
      target: { value: "Independent YouTube title" },
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    expect(within(compose).getByRole("textbox", { name: /Caption/i })).toHaveValue(
      "YouTube leads the copy",
    );
    fireEvent.click(within(compose).getByRole("button", { name: "Edit YouTube: Bizibeast" }));
    fireEvent.click(
      within(compose).getByRole("button", { name: "Turn on Sync from YouTube title" }),
    );
    fireEvent.click(within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }));
    expect(within(compose).getByRole("textbox", { name: /Caption/i })).toHaveValue(
      "Independent YouTube title",
    );
  });

  it("restores the most recent saved settings for each platform on a new post", async () => {
    vi.mocked(uploadFileResult).mockResolvedValue({
      key: "users/creator/video/post.mp4",
      publicUrl: "https://bento.surf/cdn/users/creator/video/post.mp4",
      name: "post.mp4",
      mimeType: "video/mp4",
      size: 2_000,
    });
    const connections = [
      {
        ...missingAvatar,
        id: "instagram",
        provider: "instagram" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
      {
        ...missingAvatar,
        id: "youtube",
        provider: "youtube" as const,
        avatarUrl: "https://bento.surf/avatar.png",
      },
    ];
    const post = {
      id: "11111111-1111-4111-8111-111111111199",
      status: "published",
      body: "Earlier post",
      title: "Earlier title",
      scheduledAt: null,
      createdAt: new Date().toISOString(),
      timezone: "UTC",
      media: [],
      targets: [
        {
          id: "target-ig",
          connectionId: "instagram",
          provider: "instagram",
          status: "published",
          remotePostUrl: null,
          errorMessage: null,
          publishedAt: null,
          providerSettings: {
            trialReel: true,
            graduationStrategy: "SS_PERFORMANCE",
            scheduledAutoDm: {
              triggerType: "any_comment",
              keyword: "",
              openingMessage: "Ready to send?",
              replyMessage: "Here it is",
              emailCaptureEnabled: true,
              emailPromptMessage: "Your email?",
            },
          },
        },
        {
          id: "target-yt",
          connectionId: "youtube",
          provider: "youtube",
          status: "published",
          remotePostUrl: null,
          errorMessage: null,
          publishedAt: null,
          providerSettings: { youtubePrivacy: "unlisted" },
        },
      ],
    } as SchedulerPost;
    renderScheduler({ ...schedulerData, connections, posts: [post] });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: "YouTube: Bizibeast" }));
    expect(within(compose).getByRole("combobox", { name: "YouTube visibility" })).toHaveValue(
      "unlisted",
    );
    fireEvent.click(within(compose).getByRole("button", { name: "Instagram: Bizibeast" }));
    fireEvent.change(document.querySelector('input[type="file"][accept*="video"]')!, {
      target: { files: [new File(["video"], "post.mp4", { type: "video/mp4" })] },
    });
    expect(
      await within(compose).findByRole("checkbox", { name: "Publish as a Trial Reel" }),
    ).toBeChecked();
    expect(within(compose).getByRole("combobox", { name: "Graduation strategy" })).toHaveValue(
      "SS_PERFORMANCE",
    );
    expect(
      within(compose).getByRole("checkbox", {
        name: /Auto DM after this Instagram post goes live/i,
      }),
    ).toBeChecked();
    expect(within(compose).getByRole("combobox", { name: "Trigger" })).toHaveValue("any_comment");
    expect(within(compose).getByRole("textbox", { name: "Opening message" })).toHaveValue(
      "Ready to send?",
    );
  });

  it("adds pasted images and videos while leaving text paste alone", async () => {
    vi.mocked(uploadFileResult)
      .mockReset()
      .mockImplementation(async (file) => ({
        key: `uploads/${file.name}`,
        publicUrl: `https://bento.surf/uploads/${file.name}`,
        size: file.size,
        name: file.name,
        mimeType: file.type,
      }));
    renderScheduler({
      ...schedulerData,
      connections: [
        {
          ...missingAvatar,
          id: "linkedin",
          provider: "linkedin",
          avatarUrl: "https://bento.surf/avatar.png",
        },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /Bizibeast/ }));
    const editor = within(compose).getByRole("textbox");
    const paste = (
      items: Array<{ kind: string; getAsFile: () => File | null }>,
      files: File[] = [],
    ) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items, files } });
      fireEvent(editor, event);
      return event;
    };

    expect(paste([]).defaultPrevented).toBe(false);
    const image = new File(["image"], "screenshot.jpg", { type: "image/jpeg" });
    expect(paste([{ kind: "file", getAsFile: () => image }]).defaultPrevented).toBe(true);
    await within(compose).findByRole("button", { name: "Remove screenshot.jpg" });
    expect(uploadFileResult).toHaveBeenCalledWith(
      image,
      "image",
      expect.objectContaining({ optimize: false }),
    );

    fireEvent.click(within(compose).getByRole("button", { name: "Remove screenshot.jpg" }));
    const video = new File(["video"], "clip.mp4", { type: "video/mp4" });
    expect(paste([], [video]).defaultPrevented).toBe(true);
    await within(compose).findByRole("button", { name: "Remove clip.mp4" });
    expect(prepareSchedulerVideoUpload).toHaveBeenCalledWith(
      video,
      expect.objectContaining({ providers: ["linkedin"], maxBytes: 250 * 1024 ** 2 }),
    );
    expect(uploadFileResult).toHaveBeenCalledWith(
      video,
      "video",
      expect.objectContaining({ optimize: false, onProgress: expect.any(Function) }),
    );
  });

  it("prepares an oversized video before enforcing the uploaded file allowance and shows progress", async () => {
    const original = new File(["source"], "large.mp4", { type: "video/mp4" });
    Object.defineProperty(original, "size", { value: 300 * 1024 ** 2 });
    const prepared = new File(["prepared"], "large.mp4", { type: "video/mp4" });
    let finish: (() => void) | undefined;
    vi.mocked(prepareSchedulerVideoUpload).mockImplementationOnce(async (_file, options) => {
      options.onProgress?.({ stage: "compressing", fraction: 0.5 });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return prepared;
    });
    vi.mocked(uploadFileResult)
      .mockReset()
      .mockImplementation(async (file) => ({
        key: `users/creator/video/${file.name}`,
        publicUrl: `https://bento.surf/cdn/${file.name}`,
        size: file.size,
        name: file.name,
        mimeType: file.type,
      }));
    renderScheduler({
      ...schedulerData,
      connections: [
        { ...missingAvatar, provider: "linkedin", avatarUrl: "https://bento.surf/avatar.png" },
      ],
    });
    const create = await screen.findByRole("button", { name: "Create new post" });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /Bizibeast/ }));
    const input = compose.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [original] } });
    const progress = await within(compose).findByRole("progressbar", {
      name: "Preparing a high-quality video",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "33");
    expect(within(compose).getByRole("button", { name: "Publish now" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(uploadFileResult).not.toHaveBeenCalled();
    finish?.();
    await within(compose).findByRole("button", { name: "Remove large.mp4" });
    expect(uploadFileResult).toHaveBeenCalledWith(
      prepared,
      "video",
      expect.objectContaining({ optimize: false }),
    );
    expect(within(compose).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("keeps incomplete edits until the creator explicitly discards them", async () => {
    renderScheduler();
    const create = await screen.findAllByRole("button", { name: /Create post on/i });
    fireEvent.click(create[0]);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    const editor = within(compose).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "Keep this idea" } });
    fireEvent.click(within(compose).getByRole("button", { name: "Close" }));

    const warning = await screen.findByRole("alertdialog", { name: "Save this post?" });
    expect(within(warning).getByRole("button", { name: "Save draft" })).toBeEnabled();
    fireEvent.click(within(warning).getByRole("button", { name: "Keep editing" }));

    expect(screen.getByRole("dialog", { name: "Create a post" })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Keep this idea");
    await waitFor(
      () =>
        expect(saveSocialPost).toHaveBeenCalledWith({
          data: expect.objectContaining({
            body: "Keep this idea",
            connectionIds: [],
            asDraft: true,
          }),
        }),
      { timeout: 3_000 },
    );
  });

  it("previews a selected frame locally and uploads it only when saving", async () => {
    vi.mocked(uploadFileResult)
      .mockResolvedValueOnce({
        key: "users/creator/video/post.mp4",
        publicUrl: "https://bento.surf/cdn/users/creator/video/post.mp4",
        size: 2_000,
        name: "post.mp4",
        mimeType: "video/mp4",
      })
      .mockResolvedValueOnce({
        key: "users/creator/image/thumbnail.jpg",
        publicUrl: "https://bento.surf/cdn/users/creator/image/thumbnail.jpg",
        size: 100,
        name: "video-thumbnail-8571.jpg",
        mimeType: "image/jpeg",
      });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-thumbnail"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName !== "canvas") return createElement(tagName, options);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (callback: BlobCallback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
      } as unknown as HTMLCanvasElement;
    });

    renderScheduler();
    const create = await screen.findAllByRole("button", { name: /Create post on/i });
    fireEvent.click(create[0]);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /Bizibeast/i }));
    fireEvent.change(within(compose).getByRole("textbox"), {
      target: { value: "Video caption" },
    });
    const mediaInput = document.querySelector('input[type="file"][accept*="video"]')!;
    fireEvent.change(mediaInput, {
      target: { files: [new File(["video"], "post.mp4", { type: "video/mp4" })] },
    });
    await waitFor(() => expect(uploadFileResult).toHaveBeenCalledTimes(1));

    expect(within(compose).getByTestId("scheduler-preview-scroll")).toHaveClass("overflow-hidden");
    expect(within(compose).getByTestId("scheduler-preview-pane")).toHaveTextContent("Reels");

    const preview = await screen.findByLabelText("Selected thumbnail frame");
    Object.defineProperties(preview, {
      duration: { configurable: true, value: 10 },
      videoWidth: { configurable: true, value: 1080 },
      videoHeight: { configurable: true, value: 1920 },
      currentTime: { configurable: true, writable: true, value: 1 },
    });
    fireEvent.loadedMetadata(preview);
    const strip = screen.getByRole("slider", { name: "Thumbnail frame position" });
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
    fireEvent.pointerDown(strip, { clientX: 85.71, pointerId: 1, button: 0 });
    fireEvent.pointerUp(strip, { clientX: 85.71, pointerId: 1 });

    await waitFor(() =>
      expect(document.querySelector('img[src="blob:local-thumbnail"]')).not.toBeNull(),
    );
    expect(screen.getAllByAltText("Selected cover image")).toHaveLength(1);
    expect(within(compose).getByRole("button", { name: "Add from camera roll" })).toBeVisible();
    expect(uploadFileResult).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveSocialPost).toHaveBeenCalled(), { timeout: 3_000 });

    await waitFor(() => expect(saveSocialPost).toHaveBeenCalledOnce());
    expect(uploadFileResult).toHaveBeenCalledTimes(2);
    expect(saveSocialPost).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerSettings: expect.objectContaining({
          instagram: expect.objectContaining({
            cover: expect.objectContaining({
              url: "https://bento.surf/cdn/users/creator/image/thumbnail.jpg",
            }),
          }),
        }),
      }),
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-thumbnail"));
  });

  it("saves an Instagram video's auto DM with the scheduled post", async () => {
    vi.mocked(uploadFileResult).mockResolvedValueOnce({
      key: "users/creator/video/post.mp4",
      publicUrl: "https://bento.surf/cdn/users/creator/video/post.mp4",
      size: 2_000,
      name: "post.mp4",
      mimeType: "video/mp4",
    });
    renderScheduler();
    fireEvent.click((await screen.findAllByRole("button", { name: /Create post on/i }))[0]);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /Bizibeast/i }));
    fireEvent.change(within(compose).getByRole("textbox"), { target: { value: "Video caption" } });
    fireEvent.change(document.querySelector('input[type="file"][accept*="video"]')!, {
      target: { files: [new File(["video"], "post.mp4", { type: "video/mp4" })] },
    });
    await screen.findByRole("checkbox", { name: /Auto DM after this Instagram post goes live/i });
    fireEvent.click(
      within(compose).getByRole("checkbox", {
        name: /Auto DM after this Instagram post goes live/i,
      }),
    );
    expect(within(compose).getByLabelText("Keyword")).toHaveValue(autoDmDefaults.keyword);
    expect(within(compose).getByLabelText("Opening message")).toHaveValue(
      autoDmDefaults.openingMessage,
    );
    expect(within(compose).getByLabelText("DM after they tap Send it")).toHaveValue(
      autoDmDefaults.replyMessage,
    );
    fireEvent.change(within(compose).getByRole("textbox", { name: "Keyword" }), {
      target: { value: "GUIDE" },
    });
    fireEvent.change(within(compose).getByRole("textbox", { name: "Opening message" }), {
      target: { value: "Tap Send it" },
    });
    fireEvent.change(within(compose).getByRole("textbox", { name: "DM after they tap Send it" }), {
      target: { value: "Here is the guide" },
    });
    fireEvent.click(
      within(compose).getByRole("checkbox", { name: "Reply publicly to matching comments" }),
    );
    expect(within(compose).getByLabelText("Public reply 1")).toHaveValue(
      autoDmDefaults.publicReplyMessages[0],
    );
    expect(within(compose).getByLabelText("Public reply 2")).toHaveValue(
      autoDmDefaults.publicReplyMessages[1],
    );
    expect(within(compose).getByLabelText("Public reply 3")).toHaveValue(
      autoDmDefaults.publicReplyMessages[2],
    );
    fireEvent.click(within(compose).getByText("Paste comma-separated replies"));
    fireEvent.change(within(compose).getByLabelText("Reply list"), {
      target: { value: "Check your DMs, Sent the guide\nOn its way" },
    });
    fireEvent.click(within(compose).getByRole("button", { name: "Apply reply list" }));
    fireEvent.click(
      within(compose).getByRole("checkbox", { name: "Ask them to follow before delivery" }),
    );
    fireEvent.click(
      within(compose).getByRole("checkbox", { name: "Ask for email before delivery" }),
    );
    fireEvent.change(within(compose).getByRole("textbox", { name: /Final link button text/i }), {
      target: { value: "Get guide" },
    });
    fireEvent.change(within(compose).getByRole("textbox", { name: /Secure destination URL/i }), {
      target: { value: "https://bento.surf/guide" },
    });
    await waitFor(() => expect(saveSocialPost).toHaveBeenCalled(), { timeout: 3_000 });

    await waitFor(() => expect(saveSocialPost).toHaveBeenCalledOnce());
    expect(saveSocialPost).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerSettings: expect.objectContaining({
          instagram: expect.objectContaining({
            scheduledAutoDm: expect.objectContaining({
              triggerType: "comment_keyword",
              keyword: "GUIDE",
              openingMessage: "Tap Send it",
              replyMessage: "Here is the guide",
              confirmationButtonLabel: "Send it",
              publicReplyEnabled: true,
              publicReplyMessages: ["Check your DMs", "Sent the guide", "On its way"],
              emailCaptureEnabled: true,
              followGateEnabled: true,
              replyButtonLabel: "Get guide",
              replyButtonUrl: "https://bento.surf/guide",
            }),
          }),
        }),
      }),
    });
  });

  it("saves an Instagram Trial Reel with manual graduation by default", async () => {
    vi.mocked(uploadFileResult).mockResolvedValue({
      key: "users/creator/video/trial.mp4",
      publicUrl: "https://bento.surf/cdn/users/creator/video/trial.mp4",
      size: 2_000,
      name: "trial.mp4",
      mimeType: "video/mp4",
    });

    renderScheduler();
    fireEvent.click((await screen.findAllByRole("button", { name: /Create post on/i }))[0]);
    const compose = await screen.findByRole("dialog", { name: "Create a post" });
    fireEvent.click(within(compose).getByRole("button", { name: /Bizibeast/i }));
    fireEvent.change(document.querySelector('input[type="file"][accept*="video"]')!, {
      target: { files: [new File(["video"], "trial.mp4", { type: "video/mp4" })] },
    });

    const trialReel = await within(compose).findByRole("checkbox", {
      name: "Publish as a Trial Reel",
    });
    fireEvent.click(trialReel);
    expect(within(compose).getByRole("combobox", { name: "Graduation strategy" })).toHaveValue(
      "MANUAL",
    );
    await waitFor(() => expect(saveSocialPost).toHaveBeenCalled(), { timeout: 3_000 });

    await waitFor(() => expect(saveSocialPost).toHaveBeenCalledOnce());
    expect(saveSocialPost).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerSettings: expect.objectContaining({
          instagram: expect.objectContaining({
            trialReel: true,
            graduationStrategy: "MANUAL",
          }),
        }),
      }),
    });
  });
});

describe("SchedulerStatusLine", () => {
  it("requests another repair when missing-account data is refreshed", async () => {
    const onAvatarError = vi.fn();
    const { rerender } = render(
      <SchedulerStatusLine
        connections={[missingAvatar]}
        posts={[]}
        onAvatarError={onAvatarError}
      />,
    );

    await waitFor(() => expect(onAvatarError).toHaveBeenCalledWith(missingAvatar.id));

    rerender(
      <SchedulerStatusLine
        connections={[{ ...missingAvatar }]}
        posts={[]}
        onAvatarError={onAvatarError}
      />,
    );
    expect(onAvatarError).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent repairs and retries a failed repair after cooldown", async () => {
    let now = 1_000;
    const refresh = vi
      .fn<() => Promise<{ id: string; avatarUrl: string }>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ id: missingAvatar.id, avatarUrl: "https://bento.surf/avatar.png" });
    const onSuccess = vi.fn();
    const repair = createAvatarRepairHandler({
      refresh,
      onSuccess,
      now: () => now,
      retryDelayMs: 30_000,
    });

    await Promise.all([repair(missingAvatar.id), repair(missingAvatar.id)]);
    expect(refresh).toHaveBeenCalledOnce();

    await repair(missingAvatar.id);
    expect(refresh).toHaveBeenCalledOnce();

    now += 30_000;
    await repair(missingAvatar.id);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith({
      id: missingAvatar.id,
      avatarUrl: "https://bento.surf/avatar.png",
    });
  });
});

describe("scheduler WebMCP tools", () => {
  it("caps projected scheduler connections", async () => {
    const tools = createSchedulerWebMcpTools({
      data: {
        locked: false,
        connections: Array.from({ length: 125 }, (_, index) => ({
          ...missingAvatar,
          id: `${index}`,
        })),
        posts: [],
        postingSchedule: null,
      } as never,
      onData: vi.fn(),
      onAvatar: vi.fn(),
    });
    const read = tools.find((tool) => tool.name === "bento_get_scheduler_workspace")!;
    const result = (await read.execute({}, { signal: new AbortController().signal })) as {
      structuredContent: { scheduler: { connections: unknown[] } };
    };

    expect(result.structuredContent.scheduler.connections).toHaveLength(100);
  });

  it("fails closed before mutations and applies an approved lifecycle result", async () => {
    const onData = vi.fn();
    const onAvatar = vi.fn();
    const tools = createSchedulerWebMcpTools({
      data: undefined,
      onData,
      onAvatar,
    });
    const manage = tools.find((tool) => tool.name === "bento_manage_scheduler")!;
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(
      manage.execute(
        { action: "cancel_post", id: missingAvatar.id },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("did not approve");
    expect(cancelSocialPost).not.toHaveBeenCalled();

    const next = {
      locked: false,
      plan: "creator",
      connections: [],
      posts: [],
      providers: [],
      readiness: {},
      postingSchedule: { timezone: "UTC", slots: [], naturalOffset: false },
    };
    vi.mocked(cancelSocialPost).mockResolvedValue(next as never);
    await manage.execute(
      { action: "cancel_post", id: missingAvatar.id },
      { signal: new AbortController().signal },
    );
    expect(cancelSocialPost).toHaveBeenCalledWith({ data: { id: missingAvatar.id } });
    expect(onData).toHaveBeenCalledWith(next);
    expect(savePostingSchedule).not.toHaveBeenCalled();
  });
});

describe("VideoCoverFramePicker", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubTimelineCanvas() {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,AA==",
    );
  }

  it("uses the filmstrip itself as the thumbnail scrubber", () => {
    stubTimelineCanvas();
    const onChange = vi.fn();
    const onSelectFrame = vi.fn();
    render(
      <VideoCoverFramePicker
        video={{
          key: "scheduler/user/video.mp4",
          url: "https://app.bento.surf/cdn/scheduler/user/video.mp4",
          name: "video.mp4",
          mimeType: "video/mp4",
          size: 1_000,
        }}
        timestampMs={1_000}
        onChange={onChange}
        onSelectFrame={onSelectFrame}
      />,
    );

    const preview = screen.getByLabelText("Selected thumbnail frame");
    Object.defineProperty(preview, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(preview);
    expect(document.querySelectorAll("video")).toHaveLength(1);

    const strip = screen.getByRole("slider", { name: "Thumbnail frame position" });
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
    expect(screen.queryByRole("button", { name: /Choose frame at/ })).toBeNull();
    fireEvent.pointerDown(strip, { clientX: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(strip, { clientX: 50, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(strip, { clientX: 85.71, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(5_000);
    expect(onChange).toHaveBeenLastCalledWith(8_570);
    expect(onSelectFrame).toHaveBeenCalledWith(preview, 8_570);
  });

  it("does not require a separate use-frame action", () => {
    stubTimelineCanvas();
    render(
      <VideoCoverFramePicker
        video={{
          key: "scheduler/user/video.mp4",
          url: "https://app.bento.surf/cdn/scheduler/user/video.mp4",
          name: "video.mp4",
          mimeType: "video/mp4",
          size: 1_000,
        }}
        timestampMs={1_000}
        onChange={() => {}}
      />,
    );

    const preview = screen.getByLabelText("Selected thumbnail frame");
    Object.defineProperty(preview, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(preview);
    expect(screen.queryByRole("button", { name: /Use this frame/i })).toBeNull();
  });

  it("captures the selected video frame as a JPEG file", async () => {
    const createElement = document.createElement.bind(document);
    const drawImage = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName !== "canvas") return createElement(tagName, options);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toBlob: (callback: BlobCallback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
      } as unknown as HTMLCanvasElement;
    });
    const video = {
      currentTime: 1,
      duration: 10,
      videoWidth: 1_920,
      videoHeight: 1_080,
    } as HTMLVideoElement;

    const file = await captureVideoFrame(video, 1_000);

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1_920, 1_080);
    expect(file).toMatchObject({ name: "video-thumbnail-1000.jpg", type: "image/jpeg" });
  });

  it("waits for an in-progress seek before capturing the visible frame", async () => {
    const createElement = document.createElement.bind(document);
    const drawImage = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName !== "canvas") return createElement(tagName, options);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toBlob: (callback: BlobCallback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
      } as unknown as HTMLCanvasElement;
    });
    const video = createElement("video");
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 1 },
      duration: { configurable: true, value: 10 },
      videoWidth: { configurable: true, value: 1_920 },
      videoHeight: { configurable: true, value: 1_080 },
      seeking: { configurable: true, value: true },
    });

    const capture = captureVideoFrame(video, 1_000);
    expect(drawImage).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("seeked"));
    await capture;
    expect(drawImage).toHaveBeenCalledOnce();
  });
});

it("opens the exact Agent handoff draft outside the first scheduler page without scheduling", async () => {
  const post = {
    id: "80000000-0000-4000-8000-000000000099",
    status: "draft",
    scheduledAt: null,
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    targets: [],
    media: [],
    title: "Agent handoff",
    body: "Exact Agent handoff caption",
  };
  deepLink.postId = post.id;
  vi.mocked(getSocialDraftById).mockResolvedValue({ post: JSON.stringify(post) } as never);
  vi.mocked(saveSocialPost).mockClear();
  try {
    renderScheduler();
    await screen.findByRole("dialog");
    expect(getSocialDraftById).toHaveBeenCalledWith({ data: { postId: post.id } });
    expect(screen.getAllByText("Exact Agent handoff caption").length).toBeGreaterThan(0);
    expect(saveSocialPost).not.toHaveBeenCalled();
  } finally {
    deepLink.postId = undefined;
  }
});

it("keeps account text separate and automatically previews the active editor", async () => {
  vi.mocked(saveSocialPost).mockClear();
  const connections = ["personal", "company"].map((name) => ({
    ...missingAvatar,
    avatarUrl: "https://bento.surf/avatar.png",
    id: name,
    provider: "linkedin" as const,
    displayName: name,
    handle: name,
  }));
  renderScheduler({ ...schedulerData, connections });
  const create = await screen.findByRole("button", { name: "Create new post" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  const compose = await screen.findByRole("dialog", { name: "Create a post" });
  for (const name of ["personal", "company"])
    fireEvent.click(within(compose).getByRole("button", { name: `LinkedIn: ${name}` }));
  fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/ }), {
    target: { value: "The shared starting text." },
  });
  fireEvent.click(within(compose).getByRole("switch", { name: "Sync" }));
  fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/ }), {
    target: { value: "The company announcement." },
  });
  fireEvent.click(within(compose).getByRole("button", { name: "Edit LinkedIn: personal" }));
  fireEvent.change(within(compose).getByRole("textbox", { name: /Post text/ }), {
    target: { value: "My personal lesson." },
  });
  fireEvent.click(within(compose).getByRole("button", { name: "Edit LinkedIn: company" }));
  expect(within(compose).getByRole("textbox", { name: /Post text/ })).toHaveValue(
    "The company announcement.",
  );
  expect(within(compose).getByTestId("scheduler-preview-pane")).toHaveTextContent(
    "The company announcement.",
  );
  await waitFor(
    () =>
      expect(saveSocialPost).toHaveBeenCalledWith({
        data: expect.objectContaining({
          connectionOverrides: {
            personal: { bodyOverride: "My personal lesson.", mentions: [] },
            company: { bodyOverride: "The company announcement.", mentions: [] },
          },
        }),
      }),
    { timeout: 4000 },
  );
});

it("keeps community choices per X account while text stays synced and previews follow their account", async () => {
  vi.mocked(saveSocialPost).mockClear();
  const connections = ["personal", "company"].map((name) => ({
    ...missingAvatar,
    avatarUrl: "https://bento.surf/avatar.png",
    id: name,
    provider: "twitter" as const,
    displayName: name,
    handle: name,
  }));
  const data = { ...schedulerData, connections };
  renderScheduler(data);
  vi.mocked(saveSocialPost).mockResolvedValue(data as never);
  const create = await screen.findByRole("button", { name: "Create new post" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  const compose = await screen.findByRole("dialog", { name: "Create a post" });
  for (const name of ["personal", "company"])
    fireEvent.click(within(compose).getByRole("button", { name: `X: ${name}` }));
  fireEvent.click(within(compose).getByRole("button", { name: "Community" }));
  fireEvent.change(within(compose).getByLabelText("Community link or ID"), {
    target: { value: "https://x.com/i/communities/1234567890123456789" },
  });
  fireEvent.change(within(compose).getByLabelText("Community name (optional)"), {
    target: { value: "Builders" },
  });
  fireEvent.change(within(compose).getByRole("textbox", { name: "Post" }), {
    target: { value: "One useful idea" },
  });
  fireEvent.click(within(compose).getByRole("button", { name: "Edit X: company" }));
  expect(within(compose).getByTestId("scheduler-preview-pane")).toHaveTextContent("Builders");
  fireEvent.click(within(compose).getByRole("button", { name: "Edit X: personal" }));
  expect(within(compose).getByRole("button", { name: "Everyone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(compose).getByRole("switch", { name: "Sync" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  fireEvent.click(within(compose).getByRole("button", { name: "Edit X: personal" }));
  expect(within(compose).getByTestId("scheduler-preview-pane")).not.toHaveTextContent("Builders");
  await waitFor(
    () =>
      expect(saveSocialPost).toHaveBeenCalledWith({
        data: expect.objectContaining({
          connectionOverrides: {
            personal: { xCommunity: null },
            company: {
              xCommunity: {
                id: "https://x.com/i/communities/1234567890123456789",
                name: "Builders",
              },
            },
          },
        }),
      }),
    { timeout: 4000 },
  );
});

it("restores a saved community when editing but defaults new posts to Everyone", async () => {
  const connection = {
    ...missingAvatar,
    avatarUrl: "https://bento.surf/avatar.png",
    id: "twitter",
    provider: "twitter" as const,
    displayName: "Creator",
  };
  const post: SchedulerPost = {
    id: "11111111-1111-4111-8111-111111111113",
    status: "draft",
    title: "Community draft",
    body: "Saved community post",
    scheduledAt: null,
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    media: [],
    targets: [
      {
        id: "target-x",
        connectionId: "twitter",
        provider: "twitter",
        status: "pending",
        remotePostUrl: null,
        errorMessage: null,
        publishedAt: null,
        providerSettings: { xCommunity: { id: "123", name: "Builders" } },
      },
    ],
  };
  renderScheduler({ ...schedulerData, connections: [connection], posts: [post] });
  const drafts = await screen.findByRole("region", { name: "Drafts drop area" });
  fireEvent.click(within(drafts).getByRole("button", { name: "Edit draft" }));
  const compose = await screen.findByRole("dialog", { name: "Edit post" });
  expect(within(compose).getByLabelText("Community link or ID")).toHaveValue("123");
  expect(within(compose).getByLabelText("Community name (optional)")).toHaveValue("Builders");
  fireEvent.keyDown(compose, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Edit post" })).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create new post" }));
  const next = await screen.findByRole("dialog", { name: "Create a post" });
  fireEvent.click(within(next).getByRole("button", { name: "X: Creator" }));
  expect(within(next).getByRole("button", { name: "Everyone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(within(next).getByRole("button", { name: "Community" }));
  fireEvent.change(within(next).getByLabelText("Recent X communities"), {
    target: { value: "123" },
  });
  expect(within(next).getByLabelText("Community link or ID")).toHaveValue("123");
});

it("opens media sources from Add media before opening a device upload", async () => {
  renderScheduler();
  const create = await screen.findByRole("button", { name: "Create new post" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  const composer = await screen.findByRole("dialog", { name: "Create a post" });
  fireEvent.click(within(composer).getByRole("button", { name: "Instagram: Bizibeast" }));
  fireEvent.click(within(composer).getByRole("button", { name: "Add media" }));
  const picker = await screen.findByRole("dialog", { name: "Pictures for your post" });
  expect(within(picker).getByRole("button", { name: /Stock photos/ })).toBeVisible();
  expect(within(picker).getByRole("button", { name: /Generate with AI/ })).toBeVisible();
});

function feedbackDraft(
  connections: SchedulerConnection[],
  settings: Record<string, Record<string, unknown>> = {},
): SchedulerPost {
  return {
    id: "11111111-1111-4111-8111-111111111190",
    status: "draft",
    title: null,
    body: "Day 1 of building an open source alternative. Follow along as we build.",
    scheduledAt: null,
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    media: [],
    targets: connections.map((connection) => ({
      id: `target-${connection.id}`,
      connectionId: connection.id,
      provider: connection.provider,
      status: "pending",
      remotePostUrl: null,
      errorMessage: null,
      publishedAt: null,
      providerSettings: settings[connection.provider] || {},
    })),
  };
}

async function openFeedbackDraft() {
  const drafts = await screen.findByRole("region", { name: "Drafts drop area" });
  fireEvent.click(within(drafts).getByRole("button", { name: "Edit draft" }));
  return screen.findByRole("dialog", { name: "Edit post" });
}

it("allows the saved X/LinkedIn video draft despite a previous Instagram Auto DM and preserves its independent repost settings", async () => {
  const connections = ["twitter", "linkedin"].map((provider, i) => ({
    ...missingAvatar,
    avatarUrl: "https://bento.surf/avatar.png",
    id: `11111111-1111-4111-8111-11111111119${i + 1}`,
    provider: provider as "twitter" | "linkedin",
    displayName: provider,
  }));
  const draft = feedbackDraft(connections, {
    twitter: { autoRepost: { afterHours: 24, removeAfterHours: 48 } },
    linkedin: { autoRepost: null },
  });
  draft.media = [
    {
      key: "users/creator/video/day-one.mp4",
      url: "https://bento.surf/day-one.mp4",
      name: "day-one.mp4",
      mimeType: "video/mp4",
      size: 141220266,
    },
  ];
  const previous = feedbackDraft([missingAvatar], {
    instagram: {
      scheduledAutoDm: {
        triggerType: "any_comment",
        keyword: "",
        openingMessage: "Tap Send it",
        replyMessage: "Here it is",
      },
    },
  });
  previous.id = "11111111-1111-4111-8111-111111111199";
  previous.status = "published";
  const data = { ...schedulerData, connections, posts: [previous, draft] };
  renderScheduler(data);
  vi.mocked(saveSocialPost).mockResolvedValue(data as never);
  const compose = await openFeedbackDraft();
  expect(within(compose).getByRole("button", { name: "Publish now" })).not.toHaveAttribute(
    "aria-disabled",
  );
  expect(within(compose).getByRole("button", { name: "Schedule" })).not.toHaveAttribute(
    "aria-disabled",
  );
  expect(within(compose).getByRole("checkbox", { name: "Auto-repost on X" })).toBeChecked();
  fireEvent.click(within(compose).getByRole("button", { name: "Edit LinkedIn: linkedin" }));
  expect(
    within(compose).getByRole("checkbox", { name: "Auto-repost on LinkedIn" }),
  ).not.toBeChecked();
  expect(
    within(compose)
      .getByTestId("scheduler-preview-pane")
      .querySelector('button[aria-label^="Preview "]'),
  ).toBeNull();
  const mediaButton = within(compose).getByRole("button", { name: "Add media" });
  expect(mediaButton.parentElement).toContainElement(
    within(compose).getByRole("button", { name: "Rewrite for LinkedIn" }),
  );
});

it("shows another network's blocker at the action buttons and opens its editor from the message", async () => {
  const connections = [
    {
      ...missingAvatar,
      avatarUrl: "https://bento.surf/avatar.png",
      id: "linkedin",
      provider: "linkedin" as const,
      displayName: "Company",
    },
    { ...missingAvatar, avatarUrl: "https://bento.surf/avatar.png" },
  ];
  renderScheduler({ ...schedulerData, connections, posts: [feedbackDraft(connections)] });
  const compose = await openFeedbackDraft();
  const publish = within(compose).getByRole("button", { name: "Publish now" });
  expect(publish).toHaveAttribute("aria-disabled", "true");
  expect(compose.querySelector("#scheduler-posting-feedback")).toBeNull();
  expect(screen.queryByRole("dialog", { name: "To publish this post" })).toBeNull();
  fireEvent.pointerEnter(publish, { pointerType: "mouse" });
  const feedback = await screen.findByRole("dialog", { name: "To publish this post" });
  expect(feedback).toHaveTextContent("Instagram needs an image or video");
  fireEvent.click(
    within(feedback).getByRole("button", { name: /Instagram needs an image or video/ }),
  );
  expect(
    within(compose).getByRole("button", { name: "Edit Instagram: Bizibeast" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    within(compose).getByRole("checkbox", { name: "Auto DM after this Instagram post goes live" }),
  ).toBeVisible();
});

it("lets an expired selected account be removed while explaining why it blocks publication", async () => {
  const connection = {
    ...missingAvatar,
    avatarUrl: "https://bento.surf/avatar.png",
    provider: "linkedin" as const,
    canPublish: false,
    publishBlockReason: "Reconnect LinkedIn to publish.",
  };
  renderScheduler({
    ...schedulerData,
    connections: [connection],
    posts: [feedbackDraft([connection])],
  });
  const compose = await openFeedbackDraft();
  const publish = within(compose).getByRole("button", { name: "Publish now" });
  fireEvent.focus(publish);
  expect(await screen.findByRole("dialog", { name: "To publish this post" })).toHaveTextContent(
    "Reconnect LinkedIn to publish.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close posting requirements" }));
  const account = within(compose).getByRole("button", { name: "LinkedIn: Bizibeast" });
  expect(account).toBeEnabled();
  fireEvent.click(account);
  fireEvent.click(publish);
  expect(await screen.findByRole("dialog", { name: "To publish this post" })).toHaveTextContent(
    "Select at least one account",
  );
});

it("keeps publish now available for a past schedule and retains server rejection feedback", async () => {
  const connection = {
    ...missingAvatar,
    avatarUrl: "https://bento.surf/avatar.png",
    provider: "linkedin" as const,
  };
  renderScheduler({
    ...schedulerData,
    connections: [connection],
    posts: [feedbackDraft([connection])],
  });
  const compose = await openFeedbackDraft();
  fireEvent.change(within(compose).getByLabelText("Publish at"), {
    target: { value: "2020-01-01T12:00" },
  });
  expect(within(compose).getByRole("button", { name: "Schedule" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(within(compose).getByRole("button", { name: "Publish now" })).not.toHaveAttribute(
    "aria-disabled",
  );
  vi.mocked(saveSocialPost).mockClear();
  fireEvent.click(within(compose).getByRole("button", { name: "Schedule" }));
  expect(await screen.findByRole("dialog", { name: "To schedule this post" })).toHaveTextContent(
    "at least one minute in the future",
  );
  expect(saveSocialPost).not.toHaveBeenCalled();
  expect(
    within(compose).getByRole("button", { name: "Schedule at the next posting slot" }),
  ).not.toHaveAttribute("aria-disabled");
  fireEvent.click(screen.getByRole("button", { name: "Close posting requirements" }));
  vi.mocked(saveSocialPost).mockRejectedValueOnce(
    new Error("LinkedIn rejected the attachment. Upload a new file."),
  );
  fireEvent.click(within(compose).getByRole("button", { name: "Publish now" }));
  expect(await within(compose).findByRole("alert")).toHaveTextContent(
    "LinkedIn rejected the attachment. Upload a new file.",
  );
});

it.each(["instagram", "twitter", "facebook"] as const)(
  "configures %s Auto DM inline without a manage link",
  async (provider) => {
    const connection = { ...missingAvatar, avatarUrl: "https://bento.surf/avatar.png", provider };
    renderScheduler({
      ...schedulerData,
      connections: [connection],
      posts: [feedbackDraft([connection])],
    });
    const compose = await openFeedbackDraft();
    expect(
      within(compose).queryByRole("link", { name: /Manage .* Auto DM/ }),
    ).not.toBeInTheDocument();
    expect(
      within(compose).getByRole("checkbox", { name: /Auto DM after this .* post goes live/ }),
    ).toBeVisible();
  },
);

it("keeps X and Facebook Auto DM configuration separate across tabs and saves both with the draft", async () => {
  const connections = ["twitter", "facebook"].map((provider, i) => ({
    ...missingAvatar,
    id: `11111111-1111-4111-8111-11111111117${i}`,
    provider: provider as "twitter" | "facebook",
    displayName: provider,
    avatarUrl: "https://bento.surf/avatar.png",
  }));
  const data = { ...schedulerData, connections, posts: [feedbackDraft(connections)] };
  renderScheduler(data);
  vi.mocked(saveSocialPost).mockResolvedValue(data as never);
  const compose = await openFeedbackDraft();
  fireEvent.click(
    within(compose).getByRole("checkbox", { name: "Auto DM after this X post goes live" }),
  );
  fireEvent.change(within(compose).getByLabelText("Keywords (comma separated)"), {
    target: { value: "guide, details" },
  });
  fireEvent.change(within(compose).getByLabelText("DM reply"), {
    target: { value: "Your X resource" },
  });
  fireEvent.click(within(compose).getByRole("button", { name: "Edit Facebook: facebook" }));
  fireEvent.click(
    within(compose).getByRole("checkbox", { name: "Auto DM after this Facebook post goes live" }),
  );
  expect(within(compose).getByLabelText("Keywords (comma separated)")).toHaveValue("link");
  fireEvent.change(within(compose).getByLabelText("DM after they tap Send it"), {
    target: { value: "Your Facebook resource" },
  });
  fireEvent.click(
    within(compose).getByRole("checkbox", { name: "Reply publicly to matching comments" }),
  );
  fireEvent.click(within(compose).getByRole("button", { name: "Edit X: twitter" }));
  expect(within(compose).getByLabelText("DM reply")).toHaveValue("Your X resource");
  await waitFor(
    () =>
      expect(saveSocialPost).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerSettings: expect.objectContaining({
            twitter: expect.objectContaining({
              scheduledAutoDm: expect.objectContaining({
                keywords: ["guide", "details"],
                replyMessage: "Your X resource",
              }),
            }),
            facebook: expect.objectContaining({
              scheduledAutoDm: expect.objectContaining({
                keywords: ["link"],
                replyMessage: "Your Facebook resource",
                publicReplyEnabled: true,
                publicReplyMessages: autoDmDefaults.publicReplyMessages,
              }),
            }),
          }),
        }),
      }),
    { timeout: 3000 },
  );
});

it("restores an incomplete Auto DM draft and explains missing access without blocking draft edits", async () => {
  const connection = {
    ...missingAvatar,
    provider: "twitter" as const,
    avatarUrl: "https://bento.surf/avatar.png",
    autoDmBlockReason: "Reconnect X and approve Direct Message access.",
  };
  const data = {
    ...schedulerData,
    connections: [connection],
    posts: [
      feedbackDraft([connection], {
        twitter: {
          scheduledAutoDm: {
            triggerType: "mention_keyword",
            keywords: ["draft-keyword"],
            replyMessage: "",
          },
        },
      }),
    ],
  };
  renderScheduler(data);
  vi.mocked(saveSocialPost).mockResolvedValue(data as never);
  const compose = await openFeedbackDraft();
  expect(
    within(compose).getByRole("checkbox", { name: "Auto DM after this X post goes live" }),
  ).toBeChecked();
  expect(within(compose).getByLabelText("Keywords (comma separated)")).toHaveValue("draft-keyword");
  expect(within(compose).getByLabelText("DM reply")).toHaveValue("");
  vi.mocked(saveSocialPost).mockClear();
  fireEvent.click(within(compose).getByRole("button", { name: "Schedule" }));
  const requirements = await screen.findByRole("dialog", { name: "To schedule this post" });
  expect(requirements).toHaveTextContent("Reconnect X");
  expect(within(requirements).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
  expect(saveSocialPost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close posting requirements" }));
  expect(within(compose).getByRole("button", { name: "Schedule" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  fireEvent.click(
    within(compose).getByRole("checkbox", { name: "Auto DM after this X post goes live" }),
  );
  expect(within(compose).getByRole("button", { name: "Schedule" })).not.toHaveAttribute(
    "aria-disabled",
  );
});

it("keeps the autosave failure reason visible until the next successful save", async () => {
  const connection = {
    ...missingAvatar,
    provider: "linkedin" as const,
    avatarUrl: "https://bento.surf/avatar.png",
  };
  const data = {
    ...schedulerData,
    connections: [connection],
    posts: [feedbackDraft([connection])],
  };
  renderScheduler(data);
  vi.mocked(saveSocialPost)
    .mockRejectedValueOnce(new Error("Reconnect LinkedIn to enable reposts."))
    .mockResolvedValue({ ...data, savedPostId: data.posts[0].id } as never);
  const compose = await openFeedbackDraft();
  fireEvent.change(within(compose).getByRole("textbox", { name: "Post text" }), {
    target: { value: "My updated draft text." },
  });
  expect(await within(compose).findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(
    "Draft not saved: Reconnect LinkedIn to enable reposts.",
  );
  fireEvent.change(within(compose).getByRole("textbox", { name: "Post text" }), {
    target: { value: "My corrected draft text." },
  });
  await waitFor(() => expect(within(compose).queryByRole("alert")).not.toBeInTheDocument(), {
    timeout: 3000,
  });
  expect(within(compose).getByText("Saved", { exact: true })).toBeVisible();
});

it("preserves saved Instagram replies and custom messages instead of replacing them with defaults", async () => {
  const connection = { ...missingAvatar, avatarUrl: "https://bento.surf/avatar.png" };
  const scheduledAutoDm = {
    triggerType: "comment_keyword",
    keyword: "custom",
    openingMessage: "Your custom opening",
    replyMessage: "Your custom delivery",
    publicReplyEnabled: true,
    publicReplyMessages: ["Thanks, check your inbox!", "Your resource is ready"],
  };
  const data = {
    ...schedulerData,
    connections: [connection],
    posts: [feedbackDraft([connection], { instagram: { scheduledAutoDm } })],
  };
  renderScheduler(data);
  vi.mocked(saveSocialPost).mockResolvedValue(data as never);
  const compose = await openFeedbackDraft();
  expect(within(compose).getByLabelText("Keyword")).toHaveValue("custom");
  expect(within(compose).getByLabelText("Opening message")).toHaveValue("Your custom opening");
  expect(within(compose).getByLabelText("DM after they tap Send it")).toHaveValue(
    "Your custom delivery",
  );
  expect(within(compose).getByLabelText("Public reply 1")).toHaveValue("Thanks, check your inbox!");
  expect(within(compose).getByLabelText("Public reply 2")).toHaveValue("Your resource is ready");
  expect(within(compose).getByLabelText("Public reply 3")).toHaveValue("");
  fireEvent.change(within(compose).getByLabelText("Opening message"), {
    target: { value: "Updated opening" },
  });
  await waitFor(
    () =>
      expect(saveSocialPost).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerSettings: expect.objectContaining({
            instagram: expect.objectContaining({
              scheduledAutoDm: expect.objectContaining({
                ...scheduledAutoDm,
                openingMessage: "Updated opening",
              }),
            }),
          }),
        }),
      }),
    { timeout: 3000 },
  );
});
