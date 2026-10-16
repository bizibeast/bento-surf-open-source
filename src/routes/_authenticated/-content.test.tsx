import userEvent from "@testing-library/user-event";
import type { ContentDiscoverData } from "@/lib/content-discovery.functions";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  identityError: false,
  retryIdentity: vi.fn(),
  tab: "discover" as "discover" | "agent" | "brain",
  trends: [] as ContentDiscoverData["trends"],
  send: vi.fn().mockResolvedValue({ threadId: "test-thread" }),
  identity: {
    thread: {
      id: "named-agent",
      title: "Milo",
      kind: "agent",
      pinned_at: null,
      unread_count: 2,
      last_message_at: "",
      created_at: "",
    },
    preferences: {
      user_id: "workspace",
      display_name: "Milo",
      proactive_paused: false,
      generate_images: false,
      use_face_references: false,
      platforms: ["twitter", "linkedin", "instagram"],
    },
  },
  markRead: vi.fn().mockResolvedValue({ id: "named-agent", unread_count: 1 }),
  pin: vi.fn().mockResolvedValue({ id: "old-chat" }),
  savePreferences: vi.fn(),
  feedback: vi.fn().mockResolvedValue({ saved: true }),
  setQueryData: vi.fn(),
  loadMore: vi.fn(),
  messages: [] as Array<{ id: string; role: "assistant"; content: string; payload?: unknown }>,
  mediaEnabled: false,
}));
beforeEach(() => {
  routeState.identityError = false;
  routeState.retryIdentity.mockClear();
  routeState.trends = [];
  routeState.send.mockClear();
  routeState.markRead.mockClear();
  routeState.pin.mockClear();
  routeState.messages = [];
  routeState.loadMore.mockClear();
  routeState.setQueryData.mockClear();
  routeState.savePreferences.mockResolvedValue(routeState.identity);
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isError: queryKey[0] === "content-agent-identity" && routeState.identityError,
    refetch: routeState.retryIdentity,
    data:
      queryKey[0] === "content-agent-identity"
        ? routeState.identityError
          ? undefined
          : routeState.identity
        : ["content-routines", "content-routine-activity"].includes(queryKey[0])
          ? []
          : queryKey[0] === "content-agent-threads"
            ? []
            : queryKey[0] === "content-agent-thread"
              ? {
                  thread: {
                    id: queryKey[1],
                    title: queryKey[1] === "old-chat" ? "Legacy chat" : "Milo",
                  },
                  messages: routeState.messages,
                }
              : queryKey[0] === "content-discover"
                ? {
                    winners: [],
                    patterns: [],
                    trends: routeState.trends,
                    status: "fresh",
                    ideas: [],
                    warnings: [],
                  }
                : {
                    profile: {
                      goal: "consistent_publishing",
                      nicheKeywords: [],
                      language: "en",
                      region: "global",
                      timezone: "UTC",
                      platformFrequencies: {},
                    },
                    items: [],
                    sources: [],
                  },
  }),
  useInfiniteQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled: boolean }) => {
    if (queryKey[0] === "content-brain-media") {
      routeState.mediaEnabled = enabled;
      return { data: undefined, isPending: false, hasNextPage: false, fetchNextPage: vi.fn() };
    }
    return {
      data: {
        pages: [
          {
            agent: routeState.identity.thread,
            chats: [
              {
                id: "old-chat",
                title: "Legacy chat",
                kind: "chat",
                pinned_at: null,
                unread_count: 0,
                last_message_at: "",
                created_at: "",
              },
            ],
            nextCursor: { pinnedAt: null, lastMessageAt: "", id: "old-chat" },
          },
        ],
      },
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: routeState.loadMore,
      refetch: vi.fn(),
    };
  },
  useMutation: ({
    mutationFn,
    onSuccess,
  }: {
    mutationFn: (value: unknown) => Promise<unknown>;
    onSuccess?: (value: unknown) => Promise<unknown>;
  }) => ({
    mutate: (value: unknown) => {
      void mutationFn(value).then((result) => onSuccess?.(result));
    },
    mutateAsync: async (value: unknown) => {
      const result = await mutationFn(value);
      await onSuccess?.(result);
      return result;
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: routeState.setQueryData }),
}));
vi.mock("@/lib/upload", () => ({ uploadFileResult: vi.fn() }));
vi.mock("@/lib/content-brain.functions", () => ({
  getContentBrain: vi.fn(),
  getContentBrainMedia: vi.fn(),
  recordContentBrainVisit: vi.fn().mockResolvedValue({ recorded: true }),
  saveContentProfile: vi.fn(),
  saveBrainItem: vi.fn(),
  searchContentBrainMedia: vi.fn(),
  confirmBrainItem: vi.fn(),
  setBrainItemLocked: vi.fn(),
  deleteBrainItem: vi.fn(),
}));
vi.mock("@/lib/content-agent.functions", () => ({
  listContentAgentThreadsPage: vi.fn(),
  setContentAgentThreadPinned: routeState.pin,
  markContentAgentThreadRead: routeState.markRead,
  getContentAgentThread: vi.fn(),
  sendContentAgentMessage: routeState.send,
  generateInitialBrainSuggestions: vi.fn(),
  approveAgentBrainProposal: vi.fn(),
  rejectAgentDraft: vi.fn(),
  regenerateAgentDraft: vi.fn(),
  approveAgentScheduleProposal: vi.fn(),
  saveAgentDraft: vi.fn(),
  giveContentAgentFeedback: routeState.feedback,
}));
vi.mock("@/lib/content-agent-preferences.functions", () => ({
  getContentPublishingAccounts: async () => [],
  getOrCreateNamedAgentThread: vi.fn(),
  updateContentAgentPreferences: routeState.savePreferences,
}));
vi.mock("@/lib/content-routines.functions", () => ({
  getContentRoutines: vi.fn(),
  getContentRoutineActivity: vi.fn(),
  saveContentRoutine: vi.fn(),
  setContentRoutinePaused: vi.fn(),
}));

import { ContentPage } from "./content";

describe("Content workspace", () => {
  it("keeps an old deep-linked chat usable when named identity fails", async () => {
    routeState.identityError = true;
    routeState.messages = [
      { id: "old-reply", role: "assistant", content: "Existing chat is still here." },
    ];
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" initialThread="old-chat" />);
    expect(screen.getByText("Existing chat is still here.")).toBeVisible();
    expect(screen.queryByText("Your agent could not load.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent settings" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Agent settings unavailable");
    await user.click(screen.getByRole("button", { name: "Retry agent settings" }));
    expect(routeState.retryIdentity).toHaveBeenCalled();
    await user.type(screen.getByLabelText("Message Agent"), "Keep working");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: { threadId: "old-chat", text: "Keep working", attachmentIds: [] },
    });
    expect(routeState.markRead).toHaveBeenCalledWith({
      data: { threadId: "old-chat", throughMessageId: "old-reply" },
    });
  });

  it("keeps default identity retry but allows New chat after identity failure", async () => {
    routeState.identityError = true;
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your agent could not load.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(routeState.retryIdentity).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.queryByText("Your agent could not load.")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Message Agent"), "A fresh request");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: { threadId: null, text: "A fresh request", attachmentIds: [] },
    });
  });

  it("defaults to the named agent but New chat sends without an agent thread", async () => {
    const user = userEvent.setup();
    const onThreadChange = vi.fn();
    render(<ContentPage initialTab="agent" onThreadChange={onThreadChange} />);
    expect(screen.getByRole("button", { name: "Milo" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("heading", { name: "Agent" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.type(screen.getByLabelText("Message Agent"), "A fresh chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: { threadId: null, text: "A fresh chat", attachmentIds: [] },
    });
    expect(onThreadChange).toHaveBeenCalledWith("test-thread");
  });

  it("preserves old deep links and follows a changed thread URL", async () => {
    const user = userEvent.setup();
    const view = render(<ContentPage initialTab="agent" initialThread="old-chat" />);
    expect(screen.getByRole("button", { name: "Legacy chat" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    view.rerender(<ContentPage initialTab="agent" initialThread="named-agent" />);
    await user.type(screen.getByLabelText("Message Agent"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: { threadId: "named-agent", text: "Hello", attachmentIds: [] },
    });
  });

  it("follows history back to the named default while keeping a URL-backed new chat distinct", async () => {
    const user = userEvent.setup();
    const view = render(<ContentPage initialTab="agent" initialThread="old-chat" />);
    view.rerender(<ContentPage initialTab="agent" />);
    expect(screen.getByRole("button", { name: "Milo" })).toHaveAttribute("aria-current", "page");
    view.rerender(<ContentPage initialTab="agent" initialNewChat />);
    expect(screen.getByRole("button", { name: "Milo" })).not.toHaveAttribute("aria-current");
    await user.type(screen.getByLabelText("Message Agent"), "Unsent ordinary chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: { threadId: null, text: "Unsent ordinary chat", attachmentIds: [] },
    });
    view.rerender(<ContentPage initialTab="agent" />);
    expect(screen.getByRole("button", { name: "Milo" })).toHaveAttribute("aria-current", "page");
  });

  it("wires pin, pagination, displayed read watermark and preference save endpoints", async () => {
    const user = userEvent.setup();
    routeState.messages = [
      { id: "displayed-message", role: "assistant", content: "A useful suggestion" },
    ];
    render(<ContentPage initialTab="agent" />);
    expect(routeState.markRead).toHaveBeenCalledWith({
      data: { threadId: "named-agent", throughMessageId: "displayed-message" },
    });
    await user.click(screen.getByRole("button", { name: "Pin Legacy chat" }));
    expect(routeState.pin).toHaveBeenCalledWith({ data: { threadId: "old-chat", pinned: true } });
    await user.click(screen.getByRole("button", { name: "Load more chats" }));
    expect(routeState.loadMore).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Agent settings" }));
    await user.clear(screen.getByLabelText("Agent name"));
    await user.type(screen.getByLabelText("Agent name"), "Sage");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(routeState.savePreferences).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: "Sage",
        generateImages: false,
        useFaceReferences: false,
      }),
    });
    expect(routeState.setQueryData).toHaveBeenCalledWith(
      ["content-agent-identity"],
      routeState.identity,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent settings" })).toHaveFocus();
  });

  it("uses the app sidebar instead of repeating Content tabs above the workspace", () => {
    render(<ContentPage initialTab={routeState.tab} />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Content workspace section")).not.toBeInTheDocument();
  });

  it("renders the Brain destination selected by the sidebar route", () => {
    render(<ContentPage initialTab="brain" />);
    expect(screen.getByRole("heading", { name: "My Human" })).toBeVisible();
    expect(routeState.mediaEnabled).toBe(false);
  });

  it("loads Media only when its Brain section opens", () => {
    render(<ContentPage initialTab="brain" initialBrainSection="photo" />);
    expect(routeState.mediaEnabled).toBe(true);
  });

  it("opens Routines directly from its sidebar destination", () => {
    const onRoutinesChange = vi.fn();
    render(<ContentPage initialTab="agent" initialRoutines onRoutinesChange={onRoutinesChange} />);

    expect(screen.getByRole("heading", { name: "Routines" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close Routines" }));
    expect(onRoutinesChange).toHaveBeenCalledWith(false);
  });
});

describe("Discover to Agent integration", () => {
  it.each([
    ["Chat with this post", "Help me explore this idea"],
    ["Variations", "Generate fresh angles"],
    ["Reverse Engineer", "Reverse engineer why this post works"],
    ["Replicate", "Create an original draft with my own perspective and wording"],
  ])("%s opens the real composer with the selected source", async (label, prompt) => {
    routeState.trends = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        fingerprint: "source",
        kind: "trend",
        title: "An original creator post",
        summary: "Full source context",
        sourceUrl: "https://example.com/post",
        sourceName: "Creator",
        sourcePublishedAt: new Date().toISOString(),
        sourceRetrievedAt: new Date().toISOString(),
        reason: "Relevant",
        angles: [],
        metricName: "views",
        metricValue: 100_000,
        outlierScore: null,
        feedback: "pending",
      },
    ];
    const user = userEvent.setup();
    render(<ContentPage initialTab="discover" />);
    await user.click(
      within(screen.getByRole("article", { name: "An original creator post" })).getByRole(
        "button",
        { name: "Boost in chat" },
      ),
    );
    await user.click(screen.getByRole("menuitem", { name: new RegExp(label) }));
    const composer = screen.getByRole("textbox", { name: "Message Agent" }) as HTMLTextAreaElement;
    expect(composer.value).toContain(prompt);
    expect(composer.value).toContain("https://example.com/post");
    expect(composer.value).toContain("Full source context");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: expect.objectContaining({ text: expect.stringContaining(prompt) }),
    });
  });
});

it("connects proactive rationale and feedback to the actual Agent message", async () => {
  routeState.tab = "agent";
  routeState.messages = [
    {
      id: "proactive-message",
      role: "assistant",
      content: "A useful review",
      payload: {
        action: "answer",
        message: "A useful review",
        cards: [],
        proactive: {
          signalId: "signal",
          signalKey: "key",
          whyNow: "A new source changed this week's angle.",
          feedbackActions: ["useful", "not_relevant"],
          draftBindings: [],
        },
      },
    },
  ];
  render(<ContentPage initialTab="agent" />);
  expect(screen.getByText(/A new source changed/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Not relevant" }));
  expect(routeState.feedback).toHaveBeenCalledWith({
    data: { messageId: "proactive-message", feedback: "not_relevant" },
  });
});
