import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SchedulerMediaPicker } from "./SchedulerMediaPicker";
const m = vi.hoisted(() => ({
  library: vi.fn(),
  stock: vi.fn(),
  importStock: vi.fn(),
  settings: vi.fn(),
  generate: vi.fn(),
  job: vi.fn(),
}));
vi.mock("@/lib/scheduler-assist.functions", () => ({
  getSchedulerPhotoLibrary: m.library,
  findSchedulerStockPhotos: m.stock,
  addSchedulerStockPhoto: m.importStock,
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
    stockProviders: ["commons"],
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

it("selects a configured stock source, credits Pixabay, imports the chosen result and clears stale pagination", async () => {
  m.library.mockResolvedValue({
    photos: [photo],
    cursor: null,
    stockAvailable: true,
    stockProvider: "pixabay",
    stockProviders: ["pixabay", "commons"],
  });
  m.stock.mockResolvedValue([
    {
      provider: "pixabay",
      id: 42,
      url: "https://pixabay.com/photos/coffee-42/",
      photographer: "A photographer",
      previewUrl: "https://cdn.pixabay.com/photo/coffee.jpg",
      description: "Coffee",
    },
  ]);
  m.importStock.mockResolvedValue({ media: photo });
  const onSelect = vi.fn();
  render(
    <SchedulerMediaPicker
      open
      onOpenChange={vi.fn()}
      onUpload={vi.fn()}
      onSelect={onSelect}
      initialPrompt=""
    />,
  );
  await screen.findByRole("button", { name: "Add My photo" });
  fireEvent.click(screen.getByRole("button", { name: /Stock photos/ }));
  expect(screen.getByRole("combobox", { name: "Photo source" })).toHaveValue("pixabay");
  fireEvent.change(screen.getByRole("textbox", { name: "Search stock photos" }), {
    target: { value: "coffee" },
  });
  expect(m.stock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(
    await screen.findByRole("link", { name: "Photo by A photographer · Pixabay" }),
  ).toHaveAttribute("href", "https://pixabay.com/photos/coffee-42/");
  expect(m.stock).toHaveBeenCalledWith({ data: { query: "coffee", page: 1, provider: "pixabay" } });
  fireEvent.click(screen.getByRole("button", { name: "Coffee" }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(photo));
  expect(m.importStock).toHaveBeenCalledWith({ data: { id: 42, provider: "pixabay" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Photo source" }), {
    target: { value: "commons" },
  });
  expect(screen.queryByRole("img", { name: "Coffee" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "More results" })).not.toBeInTheDocument();
  expect(m.stock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(m.stock).toHaveBeenCalledWith({
      data: { query: "coffee", page: 1, provider: "commons" },
    }),
  );
});
