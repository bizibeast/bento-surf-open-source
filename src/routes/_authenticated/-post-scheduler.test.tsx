import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerConnection } from "@/lib/social-scheduler";
import { xAccountCapabilities } from "@/lib/x-account";
import { uploadFileResult } from "@/lib/upload";
import {
  cancelSocialPost,
  getRedditCommunities,
  getSocialScheduler,
  savePostingSchedule,
  saveSocialPost,
} from "@/lib/social-scheduler.functions";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
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
  getTikTokCreatorInfo: vi.fn(),
  refreshSocialConnectionAvatar: vi.fn(),
  rescheduleSocialPost: vi.fn(),
  savePostingSchedule: vi.fn(),
  saveSocialPost: vi.fn(),
}));

vi.mock("@/lib/upload", () => ({ uploadFileResult: vi.fn() }));

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
  connections: [{ ...missingAvatar, avatarUrl: "https://example.com/avatar.png" }],
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
    fireEvent.click(within(compose).getAllByRole("button", { name: "Save draft" })[0]);
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
      fireEvent.click(within(compose).getByRole("button", { name: connection.displayName }));
    }

    const longPost = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}`).join(
      "\n\n",
    );
    fireEvent.change(within(compose).getByPlaceholderText("Write a caption for these networks"), {
      target: { value: longPost },
    });
    const previewScroll = within(compose).getByTestId("scheduler-preview-scroll");
    for (const [, label] of networks) {
      fireEvent.click(within(compose).getByRole("button", { name: label }));
      expect(previewScroll).toHaveClass("overflow-y-auto");
      expect(previewScroll).toHaveTextContent("Paragraph 30");
      expect(previewScroll.querySelector('[style*="scale("]')).toBeNull();
    }
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
    fireEvent.click(within(compose).getByRole("button", { name: "Bizibeast" }));
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
    expect(uploadFileResult).toHaveBeenCalledWith(image, "image", { optimize: false });

    fireEvent.click(within(compose).getByRole("button", { name: "Remove screenshot.jpg" }));
    const video = new File(["video"], "clip.mp4", { type: "video/mp4" });
    expect(paste([], [video]).defaultPrevented).toBe(true);
    await within(compose).findByRole("button", { name: "Remove clip.mp4" });
    expect(uploadFileResult).toHaveBeenCalledWith(video, "video", { optimize: false });
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
    expect(within(warning).getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(within(warning).getByText(/select an account before saving/i)).toBeVisible();
    fireEvent.click(within(warning).getByRole("button", { name: "Keep editing" }));

    expect(screen.getByRole("dialog", { name: "Create a post" })).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("Keep this idea");
  });

  it("previews a selected frame locally and uploads it only when saving", async () => {
    vi.mocked(uploadFileResult)
      .mockResolvedValueOnce({
        key: "users/creator/video/post.mp4",
        publicUrl: "https://example.com/cdn/users/creator/video/post.mp4",
        size: 2_000,
        name: "post.mp4",
        mimeType: "video/mp4",
      })
      .mockResolvedValueOnce({
        key: "users/creator/image/thumbnail.jpg",
        publicUrl: "https://example.com/cdn/users/creator/image/thumbnail.jpg",
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

    const preview = await screen.findByLabelText("Selected thumbnail frame");
    Object.defineProperties(preview, {
      duration: { configurable: true, value: 10 },
      videoWidth: { configurable: true, value: 1080 },
      videoHeight: { configurable: true, value: 1920 },
      currentTime: { configurable: true, writable: true, value: 1 },
    });
    fireEvent.loadedMetadata(preview);
    fireEvent.click(screen.getAllByRole("button", { name: /Choose frame at/ })[6]);

    await waitFor(() =>
      expect(document.querySelector('img[src="blob:local-thumbnail"]')).not.toBeNull(),
    );
    expect(uploadFileResult).toHaveBeenCalledTimes(1);
    fireEvent.click(within(compose).getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(saveSocialPost).toHaveBeenCalledOnce());
    expect(uploadFileResult).toHaveBeenCalledTimes(2);
    expect(saveSocialPost).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerSettings: expect.objectContaining({
          instagram: expect.objectContaining({
            cover: expect.objectContaining({
              url: "https://example.com/cdn/users/creator/image/thumbnail.jpg",
            }),
          }),
        }),
      }),
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-thumbnail");
  });

  it("saves an Instagram Trial Reel with manual graduation by default", async () => {
    vi.mocked(uploadFileResult).mockResolvedValue({
      key: "users/creator/video/trial.mp4",
      publicUrl: "https://example.com/cdn/users/creator/video/trial.mp4",
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
    fireEvent.click(within(compose).getByRole("button", { name: "Save draft" }));

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
      .mockResolvedValueOnce({
        id: missingAvatar.id,
        avatarUrl: "http://localhost:8080/avatar.png",
      });
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
      avatarUrl: "http://localhost:8080/avatar.png",
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
  it("uses the filmstrip itself as the thumbnail scrubber", () => {
    const onChange = vi.fn();
    const onSelectFrame = vi.fn();
    render(
      <VideoCoverFramePicker
        video={{
          key: "scheduler/user/video.mp4",
          url: "https://app.example.com/cdn/scheduler/user/video.mp4",
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

    const frames = screen.getAllByRole("button", { name: /Choose frame at/ });
    expect(frames).toHaveLength(8);
    expect(screen.queryByRole("slider", { name: "Thumbnail frame position" })).toBeNull();
    fireEvent.click(frames[6]);
    expect(onChange).toHaveBeenLastCalledWith(8_571);
    expect(onSelectFrame).toHaveBeenCalledWith(preview, 8_571);
  });

  it("does not require a separate use-frame action", () => {
    render(
      <VideoCoverFramePicker
        video={{
          key: "scheduler/user/video.mp4",
          url: "https://app.example.com/cdn/scheduler/user/video.mp4",
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
});
