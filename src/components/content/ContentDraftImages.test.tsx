import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  settings: vi.fn(),
  clear: vi.fn(),
  draft: vi.fn(),
  generate: vi.fn(),
  attach: vi.fn(),
  photos: vi.fn(),
}));
vi.mock("@/lib/content-agent-images.functions", () => ({
  getContentImageSettings: m.settings,
  getAgentDraftImages: m.draft,
  requestDraftImage: m.generate,
  attachAgentDraftImage: m.attach,
  clearAgentDraftBackgrounds: m.clear,
  getContentExistingPhotos: m.photos,
}));
import { ContentDraftImages } from "./ContentDraftImages";
const ref = { messageId: "message", cardId: "draft", revision: 2 };
beforeEach(() => {
  vi.clearAllMocks();
  m.settings.mockResolvedValue({
    available: true,
    quota: { successful: 7, pending: 2, resetAt: "2026-11-01T00:00:00Z" },
  });
  m.draft.mockResolvedValue({ assets: {}, jobs: [] });
  m.photos.mockResolvedValue([
    { id: "owned", url: "https://bento.surf/one.jpg", assessment: "manual" },
  ]);
});
it("shows quota and sends selected slide with a stable request key", async () => {
  render(<ContentDraftImages draftRef={ref} slideCount={3} onAssets={vi.fn()} onReady={vi.fn()} />);
  await screen.findByText(/7 \/ 100 successful/);
  fireEvent.change(screen.getByLabelText("Image for slide"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate AI image" }));
  await waitFor(() =>
    expect(m.generate).toHaveBeenCalledWith({
      data: { draftRef: ref, slideIndex: 2, requestKey: expect.any(String) },
    }),
  );
});
it("uses an existing photo with generation unavailable and no credit call", async () => {
  m.settings.mockResolvedValue({
    available: false,
    quota: { successful: 100, pending: 0, resetAt: "2026-11-01T00:00:00Z" },
  });
  const changed = vi.fn();
  render(
    <ContentDraftImages
      draftRef={ref}
      slideCount={3}
      onChanged={changed}
      onAssets={vi.fn()}
      onReady={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use existing photo" }));
  fireEvent.click(await screen.findByRole("button", { name: /Use this photo/ }));
  await waitFor(() =>
    expect(m.attach).toHaveBeenCalledWith({
      data: { draftRef: ref, mediaId: "owned", slideIndex: 0 },
    }),
  );
  expect(m.generate).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalled();
});

it.each([
  "Storage full. Free space to save this completed image; no new generation is needed.",
  "Unexpected provider output count. Support review required; no new image request was sent.",
])("shows charged state and actionable recovery detail: %s", async (detail) => {
  m.draft.mockResolvedValue({
    assets: {},
    missingMediaIds: [],
    jobs: [{ id: "job", status: "storage_pending", detail }],
  });
  render(<ContentDraftImages draftRef={ref} slideCount={3} onAssets={vi.fn()} onReady={vi.fn()} />);
  expect(await screen.findByText(detail)).toBeVisible();
  expect(screen.getByText("Generated · saving image (counted this month)")).toBeVisible();
});
it("offers an explicit all-background removal path when multiple assets are missing", async () => {
  m.draft.mockResolvedValue({ assets: {}, missingMediaIds: ["a", "b"], jobs: [] });
  const ready = vi.fn(),
    changed = vi.fn();
  render(
    <ContentDraftImages
      draftRef={ref}
      slideCount={3}
      onAssets={vi.fn()}
      onReady={ready}
      onChanged={changed}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove all slide backgrounds" }));
  await waitFor(() => expect(m.clear).toHaveBeenCalledWith({ data: ref }));
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(changed).toHaveBeenCalled();
});
