import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  artifact: vi.fn(),
  latest: vi.fn(),
  preview: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
  cancel: vi.fn(),
  publishing: vi.fn(),
}));
vi.mock("@/lib/content-chat.functions", () => ({ getChatContentArtifact: mocks.artifact }));
vi.mock("@/lib/content-reel-production.functions", () => ({
  getLatestStudioReelProduction: mocks.latest,
  previewStudioReelProduction: mocks.preview,
  prepareStudioReelProduction: mocks.prepare,
  approveStudioReelProduction: mocks.approve,
  cancelStudioReelProduction: mocks.cancel,
  approveStudioReelForScheduler: mocks.publishing,
}));
vi.mock("./ChatCarouselArtifact", () => ({ ChatCarouselArtifact: () => <p>Carousel preview</p> }));
import { ChatContentArtifact } from "./ChatContentArtifact";
const entryId = "00000000-0000-4000-8000-000000000001",
  workspaceId = "00000000-0000-4000-8000-000000000002";
const job = {
  id: "00000000-0000-4000-8000-000000000003",
  entryId,
  revision: 2,
  title: "My reel",
  status: "ready",
  estimatedMicrousd: 100000,
  duration: 20,
  avatarSeconds: 0,
  errorCode: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifact.mockResolvedValue({
    id: entryId,
    revision: 2,
    title: "My reel",
    format: "reel",
    kind: "project",
    summary: "An original reel",
  });
  mocks.latest.mockResolvedValue({ available: true, job });
  mocks.preview.mockResolvedValue({ previewUrl: "/api/studio/reel-preview?grant=private" });
});
function view(onRevise = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ChatContentArtifact workspaceId={workspaceId} entryId={entryId} onRevise={onRevise} />
    </QueryClientProvider>,
  );
  return onRevise;
}
it("plays the private finished video inside chat and offers download and conversational revision", async () => {
  const revise = view();
  expect(await screen.findByLabelText("Finished video preview")).toHaveAttribute(
    "src",
    "/api/studio/reel-preview?grant=private",
  );
  expect(screen.getByRole("link", { name: "Download video" })).toHaveAttribute("download");
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(revise).toHaveBeenCalledWith(entryId, "My reel");
  expect(screen.queryByText(/Content Studio|schemaVersion|Open editor/)).not.toBeInTheDocument();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("requires explicit production approval and preserves the estimate in chat", async () => {
  mocks.latest.mockResolvedValue({ available: true, job: { ...job, status: "awaiting_approval" } });
  view();
  const approve = await screen.findByRole("button", { name: "Create video · up to $0.10" });
  expect(mocks.approve).not.toHaveBeenCalled();
  fireEvent.click(approve);
  await waitFor(() =>
    expect(mocks.approve).toHaveBeenCalledWith({ data: { workspaceId, productionId: job.id } }),
  );
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("does not offer an old render as the result of a newer revision", async () => {
  mocks.latest.mockResolvedValue({ available: true, job: { ...job, revision: 1 } });
  view();
  await screen.findByRole("button", { name: "Prepare video" });
  expect(screen.queryByLabelText("Finished video preview")).not.toBeInTheDocument();
  expect(mocks.preview).not.toHaveBeenCalled();
});
it("shows an unavailable artifact without starting a render", async () => {
  mocks.artifact.mockRejectedValue(new Error("This content is unavailable."));
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent("This content is unavailable");
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("creates a publishing draft only after a separate explicit video approval", async () => {
  view();
  await screen.findByLabelText("Finished video preview");
  expect(mocks.publishing).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve video for publishing" }));
  await waitFor(() =>
    expect(mocks.publishing).toHaveBeenCalledWith({ data: { workspaceId, productionId: job.id } }),
  );
  expect(await screen.findByText(/Nothing has been published/)).toBeVisible();
});

it("shows the actual rendered revision after production saves its resolved assets", async () => {
  mocks.latest.mockResolvedValue({
    available: true,
    job: { ...job, revision: 1, renderRevision: 2 },
  });
  view();
  expect(await screen.findByLabelText("Finished video preview")).toBeVisible();
});

it("refreshes the saved artifact when a completed render advances its revision", async () => {
  const entry = {
    id: entryId,
    revision: 2,
    title: "My reel",
    format: "reel",
    kind: "project",
    summary: "An original reel",
  };
  mocks.artifact.mockResolvedValueOnce(entry).mockResolvedValue({ ...entry, revision: 3 });
  mocks.latest.mockResolvedValue({
    available: true,
    job: { ...job, revision: 2, renderRevision: 3 },
  });
  view();
  expect(await screen.findByLabelText("Finished video preview")).toBeVisible();
  expect(mocks.artifact).toHaveBeenCalledTimes(2);
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("shows the spoken script for review without exposing document or provider fields", async () => {
  mocks.artifact.mockResolvedValue({
    id: entryId,
    revision: 2,
    title: "My reel",
    format: "reel",
    kind: "project",
    duration: 20,
    outline: [
      {
        heading: "A stronger opening",
        text: "These are the actual spoken words.",
        duration: 2.99242630385488,
      },
    ],
  });
  mocks.latest.mockResolvedValue({ available: true, job: null });
  view();
  expect(await screen.findByText("These are the actual spoken words.")).toBeVisible();
  expect(screen.getByText("Script and visual plan")).toBeVisible();
  expect(screen.getByText("3s")).toBeVisible();
  expect(screen.queryByText(/schemaVersion|sourceSceneId|narrationJobId/)).not.toBeInTheDocument();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("recovers a failed playable preview with a fresh link without starting paid generation", async () => {
  mocks.preview
    .mockResolvedValueOnce({ previewUrl: "/expired.mp4" })
    .mockResolvedValue({ previewUrl: "/fresh.mp4" });
  view();
  const video = await screen.findByLabelText("Finished video preview");
  fireEvent.error(video);
  expect(screen.getByRole("button", { name: "Approve video for publishing" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload video preview" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Finished video preview")).toHaveAttribute("src", "/fresh.mp4"),
  );
  expect(screen.getByRole("button", { name: "Approve video for publishing" })).toBeEnabled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.publishing).not.toHaveBeenCalled();
});

it("shows real creation stages while a render is active, without an invented progress percentage", async () => {
  mocks.latest.mockResolvedValue({ available: true, job: { ...job, status: "avatars" } });
  view();
  expect(await screen.findByRole("list", { name: "Video creation progress" })).toHaveTextContent(
    "Narration complete",
  );
  expect(screen.getByRole("list", { name: "Video creation progress" })).toHaveTextContent(
    "Visuals in progress",
  );
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
