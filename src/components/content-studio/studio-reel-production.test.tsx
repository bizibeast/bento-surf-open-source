import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StudioReelProduction } from "./studio-reel-production";
import { studioStarter } from "@/lib/content-studio";
import { DEFAULT_AGENT_BRANDING } from "@/lib/content-agent-branding";
const f = vi.hoisted(() => ({
  job: null as unknown,
  available: true,
  approve: vi.fn(),
  schedule: vi.fn(),
  prepare: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => f.navigate }));
vi.mock("@/lib/content-reel-production.functions", () => ({
  getLatestStudioReelProduction: async () => ({ available: f.available, job: f.job }),
  prepareStudioReelProduction: (...args: unknown[]) => f.prepare(...args),
  approveStudioReelProduction: (...args: unknown[]) => f.approve(...args),
  cancelStudioReelProduction: async () => {},
  previewStudioReelProduction: async () => ({
    previewUrl: "/api/studio/reel-preview?grant=fixture",
  }),
  approveStudioReelForScheduler: (...args: unknown[]) => f.schedule(...args),
}));
vi.mock("@/lib/external-tools.functions", () => ({
  listHeyGenAvatars: vi.fn(),
  listHeyGenVoices: vi.fn(),
}));
const workspaceId = "11111111-1111-4111-8111-111111111111";
function setup() {
  const entry = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING);
  entry.revision = 1;
  if (entry.document.format !== "reel") throw Error("fixture");
  entry.document.voiceId = "voice";
  const persist = vi.fn(async () => entry);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StudioReelProduction
        workspaceId={workspaceId}
        entry={entry}
        document={entry.document}
        onChange={vi.fn()}
        onPersist={persist}
      />
    </QueryClientProvider>,
  );
  return { persist };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.prepare.mockReset();
  f.available = true;
  f.job = {
    id: "33333333-3333-4333-8333-333333333333",
    revision: 1,
    status: "awaiting_approval",
    duration: 45,
    avatarSeconds: 15,
    estimatedMicrousd: 456789,
    mediaIds: [],
    publication: null,
  };
  f.schedule.mockResolvedValue({ postId: "post" });
});
describe("managed production approval controls", () => {
  it("shows a conservatively rounded estimate and requires a click before spending", async () => {
    const { persist } = setup();
    const button = await screen.findByRole("button", { name: "Approve production · up to $0.46" });
    expect(f.approve).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(f.approve).toHaveBeenCalledTimes(1));
    expect(persist).toHaveBeenCalledOnce();
  });
  it("shows a private preview and requires separate approval before Scheduler", async () => {
    f.job = { ...(f.job as object), status: "ready" };
    setup();
    const video = await screen.findByLabelText("Finished Reel preview");
    expect(video).toHaveAttribute("src", "/api/studio/reel-preview?grant=fixture");
    expect(f.schedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve video & review scheduling" }));
    await waitFor(() =>
      expect(f.navigate).toHaveBeenCalledWith({
        to: "/post-scheduler",
        search: { postId: "post" },
      }),
    );
    expect(f.approve).not.toHaveBeenCalled();
  });
  it("hides managed controls when the workflow is not configured", async () => {
    f.job = null;
    f.available = false;
    setup();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Managed Reel production" }),
      ).not.toBeInTheDocument(),
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.approve).not.toHaveBeenCalled();
  });
  it("prepares a fresh attempt after a known failure without changing the saved project", async () => {
    f.job = { ...(f.job as object), status: "failed" };
    f.prepare.mockImplementation(async () => {
      f.job = { ...(f.job as object), id: crypto.randomUUID() };
    });
    setup();
    const button = await screen.findByRole("button", { name: "Prepare production estimate" });
    fireEvent.click(button);
    await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
    expect(f.prepare.mock.calls[0][0].data.requestId).not.toBe(
      f.prepare.mock.calls[1][0].data.requestId,
    );
  });
});
