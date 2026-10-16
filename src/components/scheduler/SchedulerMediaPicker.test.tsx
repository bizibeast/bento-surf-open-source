import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SchedulerMediaPicker } from "./SchedulerMediaPicker";
const m = vi.hoisted(() => ({
  library: vi.fn(),
  stock: vi.fn(),
  settings: vi.fn(),
  generate: vi.fn(),
  job: vi.fn(),
}));
vi.mock("@/lib/scheduler-assist.functions", () => ({
  getSchedulerPhotoLibrary: m.library,
  findSchedulerStockPhotos: m.stock,
  addSchedulerStockPhoto: vi.fn(),
  getSchedulerImageSettings: m.settings,
  generateSchedulerImage: m.generate,
  getSchedulerImageJob: m.job,
}));
vi.mock("@/lib/upload", () => ({ uploadFileResult: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
const photo = {
  key: "users/owner/image/photo.jpg",
  url: "https://bento.surf/photo.jpg",
  mimeType: "image/jpeg",
  size: 100,
  name: "My photo",
};
beforeEach(() => {
  vi.clearAllMocks();
  m.library.mockResolvedValue({
    photos: [photo],
    cursor: null,
    stockAvailable: true,
    stockProvider: "commons",
  });
  m.settings.mockResolvedValue({
    available: true,
    enabled: true,
    quota: { successful: 20, pending: 2, limit: 100 },
    referenceIds: [],
  });
  m.generate.mockResolvedValue({ id: "job", status: "queued" });
  m.job.mockResolvedValue({ id: "job", status: "ready", detail: "Ready", media: photo });
});
it("offers upload, saved photos, free stock and AI without making paid requests on open", async () => {
  const onSelect = vi.fn();
  render(
    <SchedulerMediaPicker
      open
      onOpenChange={vi.fn()}
      onUpload={vi.fn()}
      onSelect={onSelect}
      initialPrompt="A thoughtful illustration"
    />,
  );
  for (const name of ["Upload", "Your photos", "Stock photos", "Generate with AI"])
    expect(screen.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: "Add My photo" }));
  expect(onSelect).toHaveBeenCalledWith(photo);
  expect(m.generate).not.toHaveBeenCalled();
});
it("requires permission for selected references and shares the Agent image quota", async () => {
  render(
    <SchedulerMediaPicker
      open
      onOpenChange={vi.fn()}
      onUpload={vi.fn()}
      onSelect={vi.fn()}
      initialPrompt="A thoughtful illustration"
    />,
  );
  await screen.findByRole("button", { name: "Add My photo" });
  fireEvent.click(screen.getByRole("button", { name: /Generate with AI/ }));
  expect(await screen.findByText(/78 of 100 images remaining/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Choose from your photos" }));
  fireEvent.click(screen.getByRole("button", { name: "Reference My photo" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("button", { name: "Generate image · 1 credit" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Generate image · 1 credit" }));
  await waitFor(() =>
    expect(m.generate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        referenceKeys: [photo.key],
        referencesConfirmed: true,
        prompt: "A thoughtful illustration",
      }),
    }),
  );
  expect(await screen.findByRole("button", { name: "Use this image" })).toBeVisible();
});
it("does not search on every keystroke", async () => {
  render(
    <SchedulerMediaPicker
      open
      onOpenChange={vi.fn()}
      onUpload={vi.fn()}
      onSelect={vi.fn()}
      initialPrompt=""
    />,
  );
  await screen.findByRole("button", { name: "Add My photo" });
  fireEvent.click(screen.getByRole("button", { name: /Stock photos/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search stock photos" }), {
    target: { value: "coffee" },
  });
  expect(m.stock).not.toHaveBeenCalled();
});
