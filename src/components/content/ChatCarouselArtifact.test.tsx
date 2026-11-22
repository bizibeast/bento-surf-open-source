import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), create: vi.fn(), media: vi.fn() }));
vi.mock("@/lib/studio-carousel-jobs.functions", () => ({
  getStudioCarouselJob: mocks.status,
  startStudioCarouselJob: mocks.create,
}));
vi.mock("@/lib/content-studio.functions", () => ({ listContentStudioMedia: mocks.media }));
import { ChatCarouselArtifact } from "./ChatCarouselArtifact";
const input = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  entryId: "00000000-0000-4000-8000-000000000002",
  revision: 3,
};
beforeEach(() => {
  vi.clearAllMocks();
});
function view() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ChatCarouselArtifact {...input} />
    </QueryClientProvider>,
  );
}
it("shows exported slides in their original order inside chat", async () => {
  mocks.status.mockResolvedValue({
    available: true,
    job: { id: input.entryId, status: "ready", media_ids: ["second", "first"] },
  });
  mocks.media.mockResolvedValue({
    assets: [
      { id: "first", url: "/cdn/one.jpg" },
      { id: "second", url: "/cdn/two.jpg" },
    ],
  });
  view();
  expect(await screen.findByAltText("Slide 1")).toHaveAttribute("src", "/cdn/two.jpg");
  expect(screen.getByRole("button", { name: "Previous slide" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
  expect(screen.getByAltText("Slide 2")).toHaveAttribute("src", "/cdn/one.jpg");
  expect(screen.getByRole("link", { name: "Download slide 2" })).toHaveAttribute(
    "href",
    "/cdn/one.jpg",
  );
  expect(screen.getByRole("button", { name: "Next slide" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("region", { name: "Carousel preview" }), { key: "ArrowLeft" });
  expect(screen.getByAltText("Slide 1")).toHaveAttribute("src", "/cdn/two.jpg");
  fireEvent.click(screen.getByRole("button", { name: "View slide 2" }));
  expect(screen.getByRole("button", { name: "View slide 2" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const preview = screen.getByRole("region", { name: "Carousel preview" });
  fireEvent.touchStart(preview, { touches: [{ clientX: 50, clientY: 100 }] });
  fireEvent.touchEnd(preview, { changedTouches: [{ clientX: 210, clientY: 110 }] });
  expect(screen.getByAltText("Slide 1")).toHaveAttribute("src", "/cdn/two.jpg");
  fireEvent.touchStart(preview, { touches: [{ clientX: 210, clientY: 100 }] });
  fireEvent.touchEnd(preview, { changedTouches: [{ clientX: 200, clientY: 280 }] });
  expect(screen.getByAltText("Slide 1")).toBeVisible();
  expect(mocks.create).not.toHaveBeenCalled();
});
it("shows the render estimate and starts only after the creator clicks", async () => {
  mocks.status.mockResolvedValue({ available: true, costMicrousd: 10000, job: null });
  view();
  const button = await screen.findByRole("button", { name: "Create carousel" });
  expect(screen.getByText(/0.0100/)).toBeVisible();
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(mocks.create).toHaveBeenCalledWith({ data: { ...input, format: "carousel" } }),
  );
});
it("does not automatically retry a failed export or read reference media", async () => {
  mocks.status.mockResolvedValue({ available: true, job: { status: "failed" } });
  view();
  await screen.findByText(/carousel stopped/);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.media).not.toHaveBeenCalled();
});
