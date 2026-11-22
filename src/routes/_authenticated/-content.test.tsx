import type { ManagedSpendStatus } from "@/lib/provider-budget.server";
import { BENNY_EDITING_MODELS, type BentoModelOption } from "@/lib/benny-models";
import userEvent from "@testing-library/user-event";
import type { BennyProviderPreferences } from "@/lib/benny-byok";
import type { ContentDiscoverData } from "@/lib/content-discovery.functions";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  identityError: false,
  bennySettings: null as
    | (BennyProviderPreferences & {
        managedAvailable: boolean;
        searchConnected?: boolean;
        bentoModels?: BentoModelOption[];
        managedUsage?: ManagedSpendStatus;
      })
    | null,
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
  referencesEnabled: false,
  studioWorkspaceId: null as string | null,
}));
beforeEach(() => {
  routeState.identityError = false;
  routeState.referencesEnabled = false;
  routeState.studioWorkspaceId = null;
  routeState.bennySettings = null;
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
      queryKey[0] === "benny-ai-settings"
        ? routeState.bennySettings
        : queryKey[0] === "content-agent-identity"
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
    ...(queryKey[0] === "content-reference-capability"
      ? { data: routeState.referencesEnabled }
      : {}),
    ...(queryKey[0] === "content-studio-access" ? { data: routeState.studioWorkspaceId } : {}),
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
vi.mock("@/components/content/ContentReferences", () => ({
  ContentReferences: ({ initialId }: { initialId?: string }) => (
    <div>Reference detail {initialId}</div>
  ),
}));
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
  it("hides the References button and a direct link when the server capability is disabled", () => {
    render(
      <ContentPage initialTab="agent" initialReference="00000000-0000-4000-8000-000000000010" />,
    );
    expect(screen.queryByRole("button", { name: "References" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Content references" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Reference detail/)).not.toBeInTheDocument();
  });

  it("opens the deep-linked References dialog when the server capability is enabled", () => {
    routeState.referencesEnabled = true;
    routeState.studioWorkspaceId = "00000000-0000-4000-8000-000000000011";
    const id = "00000000-0000-4000-8000-000000000010";
    render(<ContentPage initialTab="agent" initialReference={id} />);
    expect(screen.getByRole("button", { name: "References", hidden: true })).toHaveAttribute(
      "data-reference-workspace-id",
      routeState.studioWorkspaceId,
    );
    expect(screen.getByRole("dialog", { name: "Content references" })).toBeVisible();
    expect(screen.getByText(`Reference detail ${id}`)).toBeVisible();
  });
  it("keeps an old deep-linked chat usable when named identity fails", async () => {
    routeState.identityError = true;
    routeState.messages = [
      { id: "old-reply", role: "assistant", content: "Existing chat is still here." },
    ];
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" initialThread="old-chat" />);
    expect(screen.getByText("Existing chat is still here.")).toBeVisible();
    expect(screen.queryByText("Your agent could not load.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Benny preferences unavailable");
    await user.click(screen.getByRole("button", { name: "Retry Benny preferences" }));
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

  it("uses a saved OpenRouter default and switches models without changing the conversation", async () => {
    routeState.bennySettings = {
      providers: [
        { id: "provider-a", name: "First", model: "author/one" },
        { id: "provider-b", name: "Second", model: "author/two" },
      ],
      defaultProviderId: "provider-a",
      managedAvailable: false,
    };
    routeState.send.mockResolvedValueOnce({ threadId: "old-chat" });
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" initialThread="old-chat" />);
    const model = screen.getByRole("button", { name: "Benny model" });
    const composer = screen.getByLabelText("Message Agent");
    expect(model).toHaveTextContent("author/one");
    expect(model.closest("form")).toBe(composer.closest("form"));
    expect(screen.queryByRole("option", { name: "Default model" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attachments" })).toBeDisabled();
    await user.type(composer, "First turn");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(model);
    await user.click(screen.getByRole("menuitemradio", { name: "author/two · Your key" }));
    await user.type(composer, "Follow-up");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send.mock.calls).toEqual([
      [
        {
          data: {
            aiProviderId: "provider-a",
            threadId: "old-chat",
            text: "First turn",
            attachmentIds: [],
          },
        },
      ],
      [
        {
          data: {
            aiProviderId: "provider-b",
            threadId: "old-chat",
            text: "Follow-up",
            attachmentIds: [],
          },
        },
      ],
    ]);
  });

  it("offers all named managed models and sends the selected ID with native tools enabled", async () => {
    routeState.bennySettings = {
      providers: [],
      defaultProviderId: null,
      managedAvailable: true,
      bentoModels: BENNY_EDITING_MODELS.map(({ id, name, available }) => ({ id, name, available })),
      managedUsage: {
        eligible: true,
        weekly: {
          limitMicrousd: 6250000,
          remainingMicrousd: 6250000,
          resetsAt: "2026-11-23T00:00:00Z",
        },
        monthly: {
          limitMicrousd: 25000000,
          remainingMicrousd: 25000000,
          resetsAt: "2026-12-01T00:00:00Z",
        },
      },
    };
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" />);
    const model = screen.getByRole("button", { name: "Benny model" });
    expect(
      screen.queryByText(/this week ·|this month|Allowance running low/),
    ).not.toBeInTheDocument();
    expect(model).toHaveTextContent("GPT 6.1 Sol");
    await user.click(model);
    for (const item of BENNY_EDITING_MODELS)
      expect(screen.getByRole("menuitemradio", { name: item.name })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("button", { name: /Connect a model|Manage AI providers/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attachments" })).toBeEnabled();
    await user.click(model);
    await user.click(screen.getByRole("menuitemradio", { name: "Opus 5.5" }));
    await user.type(screen.getByLabelText("Message Agent"), "Edit my reel");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: {
        threadId: "named-agent",
        text: "Edit my reel",
        attachmentIds: [],
        aiModel: "anthropic/claude-opus-5.5",
      },
    });
  });

  it("preserves the legacy model route with its actual name", async () => {
    routeState.bennySettings = {
      providers: [],
      defaultProviderId: null,
      managedAvailable: true,
      bentoModels: [{ id: "bento", name: "GLM 5.3 Flash" }],
    };
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" />);
    expect(screen.getByRole("button", { name: "Benny model" })).toHaveTextContent("GLM 5.3 Flash");
    await user.type(screen.getByLabelText("Message Agent"), "A question");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: { threadId: "named-agent", text: "A question", attachmentIds: [] },
    });
  });

  it("keeps unconfigured BYOK creators from sending without an inline connection dialog", async () => {
    routeState.bennySettings = {
      providers: [],
      defaultProviderId: null,
      managedAvailable: false,
      bentoModels: [],
    };
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" />);
    await user.type(screen.getByLabelText("Message Agent"), "A question");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Connect a model|Manage AI providers/ }),
    ).not.toBeInTheDocument();
    expect(routeState.send).not.toHaveBeenCalled();
  });

  it("keeps Enter in web search configuration from submitting the message form", async () => {
    routeState.bennySettings = {
      providers: [],
      defaultProviderId: null,
      managedAvailable: true,
      searchConnected: true,
    };
    const user = userEvent.setup();
    render(<ContentPage initialTab="agent" />);
    await user.type(screen.getByLabelText("Message Agent"), "Research my next post");
    await user.click(screen.getByRole("button", { name: "Web search" }));
    await user.type(screen.getByLabelText("Public web search query"), "Creator trends{Enter}");
    expect(routeState.send).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message Agent")).toHaveValue("Research my next post");
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
    expect(screen.queryByRole("button", { name: "Agent settings" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit memory" }));
    const memory = screen.getByRole("dialog", { name: "Memory" });
    await user.click(within(memory).getByRole("button", { name: "Preferences" }));
    expect(screen.queryByLabelText("Benny’s name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(routeState.savePreferences).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: "Benny",
        generateImages: false,
        useFaceReferences: false,
      }),
    });
    expect(routeState.setQueryData).toHaveBeenCalledWith(
      ["content-agent-identity"],
      routeState.identity,
    );
    expect(memory).toBeVisible();
    expect(within(memory).getByRole("status")).toHaveTextContent("Saved to memory.");
    await user.click(within(memory).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit memory" })).toHaveFocus());
  });

  it("uses the app sidebar instead of repeating Content tabs above the workspace", () => {
    render(<ContentPage initialTab={routeState.tab} />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Content workspace section")).not.toBeInTheDocument();
  });

  it("renders the Brain destination selected by the sidebar route", () => {
    render(<ContentPage initialTab="brain" />);
    expect(screen.getByRole("heading", { name: "About You" })).toBeVisible();
    expect(routeState.mediaEnabled).toBe(false);
  });

  it("opens existing instruction links inside Memory", () => {
    render(<ContentPage initialTab="brain" initialBrainSection="instruction" />);
    expect(screen.getByRole("dialog", { name: "Memory" })).toBeVisible();
    expect(
      screen
        .getByRole("navigation", { name: "Brain sections" })
        .querySelector('[aria-current="page"]'),
    ).toHaveTextContent("Instructions");
    expect(screen.queryByRole("button", { name: "Edit instructions" })).not.toBeInTheDocument();
  });

  it("loads Media only when its Brain section opens", () => {
    render(<ContentPage initialTab="brain" initialBrainSection="photo" />);
    expect(routeState.mediaEnabled).toBe(true);
  });

  it.each([
    ["memory", "Memory"],
    ["schedule", "Schedule"],
  ])("opens %s in a centered editor above the conversation", (section, title) => {
    render(<ContentPage initialTab="agent" initialThread="old-chat" />);
    fireEvent.click(screen.getByRole("button", { name: `Edit ${section}` }));
    expect(screen.getByRole("dialog", { name: title })).toBeVisible();
    expect(document.querySelector('[aria-label="Content chat"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Agent")).toBeVisible();
  });

  it("keeps source files inside Memory without a separate Context entry", () => {
    render(<ContentPage initialTab="agent" />);
    expect(screen.queryByRole("button", { name: "Context" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit context" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
    const memory = screen.getByRole("dialog", { name: "Memory" });
    fireEvent.click(within(memory).getByRole("button", { name: "Files" }));
    expect(within(memory).getByLabelText("Upload files")).toBeInTheDocument();
    expect(within(memory).getByRole("button", { name: "Preferences" })).toBeVisible();
  });

  it("opens legacy file links within Memory and retains its navigation", () => {
    render(<ContentPage initialTab="brain" initialBrainSection="file" />);
    const memory = screen.getByRole("dialog", { name: "Memory" });
    expect(within(memory).getByLabelText("Upload files")).toBeInTheDocument();
    fireEvent.click(within(memory).getByRole("button", { name: "Preferences" }));
    expect(within(memory).getByRole("heading", { name: "Benny preferences" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Context" })).not.toBeInTheDocument();
  });

  it("opens Routines directly from its sidebar destination", () => {
    const onRoutinesChange = vi.fn();
    render(<ContentPage initialTab="agent" initialRoutines onRoutinesChange={onRoutinesChange} />);

    expect(screen.getByRole("heading", { name: "Schedule" })).toBeVisible();
    const schedule = screen.getByRole("dialog", { name: "Schedule" });
    expect(
      within(schedule).queryByRole("button", { name: "Close Routines" }),
    ).not.toBeInTheDocument();
    expect(
      within(schedule).queryByRole("button", { name: "Memory preferences" }),
    ).not.toBeInTheDocument();
    expect(within(schedule).getByRole("button", { name: "New Routine" })).toBeVisible();
    fireEvent.click(within(schedule).getByRole("button", { name: "Close" }));
    expect(onRoutinesChange).toHaveBeenCalledWith(false);
  });
});

describe("Discover to Agent integration", () => {
  it.each([
    ["Send to Benny", "Help me explore the selected Discover post", "chat"],
    ["Variations", "Generate fresh angles", "variations"],
    ["Generate stronger hooks", "Write five original hooks", "hooks"],
    ["Reverse Engineer", "Reverse engineer why this post works", "reverse-engineer"],
    ["Remix", "Create an original draft with my own perspective and wording", "replicate"],
    ["Create content brief", "Create an original content brief", "brief"],
  ])("%s opens the real composer with the selected source", async (label, prompt, action) => {
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
        { name: "Post actions" },
      ),
    );
    await user.click(screen.getByRole("menuitem", { name: new RegExp(label) }));
    const composer = screen.getByRole("textbox", { name: "Message Agent" }) as HTMLTextAreaElement;
    expect(composer.value).toContain(prompt);
    expect(composer.value).not.toContain("https://example.com/post");
    expect(composer.value).not.toContain("Full source context");
    expect(screen.getByRole("button", { name: "Remove Discover source" })).toHaveTextContent(
      "An original creator post",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(routeState.send).toHaveBeenCalledWith({
      data: expect.objectContaining({
        text: expect.stringContaining(prompt),
        discoverPost: { recommendationId: "11111111-1111-4111-8111-111111111111", action },
      }),
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

it("opens legacy studio links in chat without an editor dialog or saved-project navigation", () => {
  render(<ContentPage initialTab="studio" />);
  expect(screen.getByLabelText("Message Agent")).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Content editor" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open saved projects" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Content Studio|Loading Studio/)).not.toBeInTheDocument();
});
