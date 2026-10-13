import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentDiscoverData } from "@/lib/content-discovery.functions";

const routeState = vi.hoisted(() => ({
  tab: "discover" as "discover" | "agent" | "brain",
  trends: [] as ContentDiscoverData["trends"],
  send: vi.fn().mockResolvedValue({ threadId: "test-thread" }),
  mediaEnabled: false,
}));
beforeEach(() => {
  routeState.trends = [];
  routeState.send.mockClear();
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: ({ enabled }: { enabled: boolean }) => {
    routeState.mediaEnabled = enabled;
    return { data: undefined, isPending: false, hasNextPage: false, fetchNextPage: vi.fn() };
  },
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: ["content-routines", "content-routine-activity"].includes(queryKey[0])
      ? []
      : queryKey[0] === "content-agent-threads"
        ? []
        : queryKey[0] === "content-agent-thread"
          ? { messages: [] }
          : queryKey[0] === "content-discover"
            ? {
                winners: [],
                patterns: [],
                trends: [],
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
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/upload", () => ({ uploadFileResult: vi.fn() }));
vi.mock("@/lib/content-brain.functions", () => ({
  getContentBrain: vi.fn(),
  getContentBrainMedia: vi.fn(),
  saveContentProfile: vi.fn(),
  saveBrainItem: vi.fn(),
  searchContentBrainMedia: vi.fn(),
  confirmBrainItem: vi.fn(),
  setBrainItemLocked: vi.fn(),
  deleteBrainItem: vi.fn(),
}));
vi.mock("@/lib/content-agent.functions", () => ({
  listContentAgentThreads: vi.fn(),
  getContentAgentThread: vi.fn(),
  sendContentAgentMessage: vi.fn(),
  generateInitialBrainSuggestions: vi.fn(),
  approveAgentBrainProposal: vi.fn(),
  rejectAgentDraft: vi.fn(),
  regenerateAgentDraft: vi.fn(),
  approveAgentScheduleProposal: vi.fn(),
  saveAgentDraft: vi.fn(),
}));
vi.mock("@/lib/content-routines.functions", () => ({
  getContentRoutines: vi.fn(),
  getContentRoutineActivity: vi.fn(),
  saveContentRoutine: vi.fn(),
  setContentRoutinePaused: vi.fn(),
}));

import { ContentPage } from "./content";

describe("Content workspace", () => {
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
