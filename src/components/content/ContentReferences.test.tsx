import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContentReferences } from "./ContentReferences";
const getReferences = vi.hoisted(() => vi.fn());
const getReference = vi.hoisted(() => vi.fn());
const startReference = vi.hoisted(() => vi.fn());
vi.mock("@/lib/content-reference.functions", () => ({
  getContentReferences: getReferences,
  getContentReference: getReference,
  startContentReference: startReference,
}));
vi.mock("@/hooks/use-page-activity", () => ({
  usePageActivity: () => ({ visibility: "visible", idle: false }),
}));
const id = "11111111-1111-4111-8111-111111111111";
function show(onUse = vi.fn(), initialId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContentReferences onUse={onUse} initialId={initialId} />
    </QueryClientProvider>,
  );
}
afterEach(() => vi.clearAllMocks());
it("shows real pending status without claiming visual analysis or offering creation", async () => {
  getReferences.mockResolvedValue([{ id, status: "processing", evidence: null }]);
  show();
  expect(await screen.findByText("Studying the reference…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create with Benny" })).not.toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
it("labels a sampled grid, shows warnings and uses completed evidence for an editable template", async () => {
  getReferences.mockResolvedValue([
    {
      id,
      status: "ready",
      gridUrl: "/api/content-reference/asset?grant=fixture",
      frameMetadataUrl: "/api/content-reference/asset?grant=metadata",
      evidence: {
        format: "reel",
        visuals: [{ index: 0, description: "Large opening title over two panels" }],
        warnings: ["Music was not analyzed."],
        grid: { mode: "overview", includedFrameCount: 24, decodedFrameCount: 1350 },
      },
    },
  ]);
  const onUse = vi.fn();
  show(onUse);
  expect(await screen.findByText(/24 of 1350 decoded frames/)).toHaveTextContent(
    "Sampled overview",
  );
  expect(screen.getByText("Music was not analyzed.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Make a template" }));
  expect(onUse).toHaveBeenCalledWith(expect.stringContaining(`completed reference analysis ${id}`));
  expect(onUse.mock.calls[0][0]).toContain("bracketed placeholders");
});

const olderId = "22222222-2222-4222-8222-222222222222";
const ready = (id: string, description: string) => ({
  id,
  status: "ready",
  evidence: { format: "image", visuals: [{ index: 0, description }], warnings: [] },
});

it.each(["missing", "expired"])(
  "never shows the latest evidence for a %s explicit link",
  async () => {
    getReferences.mockResolvedValue([ready(id, "Unrelated source")]);
    getReference.mockRejectedValueOnce(
      new Error("This reference is unavailable in this workspace or has expired."),
    );
    show(vi.fn(), olderId);
    expect(await screen.findByRole("alert")).toHaveTextContent("This reference is unavailable");
    expect(getReference).toHaveBeenCalledExactlyOnceWith({ data: { id: olderId } });
    expect(screen.queryByText("Unrelated source")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create with Benny" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make a template" })).not.toBeInTheDocument();
  },
);

it("loads and hands off an explicit reference older than the list window", async () => {
  getReferences.mockResolvedValue([ready(id, "Latest source")]);
  getReference.mockResolvedValueOnce(ready(olderId, "Requested source"));
  const onUse = vi.fn();
  show(onUse, olderId);
  expect(await screen.findByText("Requested source")).toBeInTheDocument();
  expect(screen.queryByText("Latest source")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Reference" })).toHaveValue(olderId);
  expect(screen.getByRole("region", { name: "Reference analysis" })).toHaveAttribute(
    "data-reference-job-id",
    olderId,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create with Benny" }));
  expect(onUse).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(olderId));
});

it("uses the fresh selected status when a reference is already in the list", async () => {
  getReferences.mockResolvedValue([{ id, status: "queued", evidence: null }]);
  getReference.mockResolvedValue(ready(id, "Requested source"));
  show(vi.fn(), id);
  expect(await screen.findByRole("option", { name: "Reference 1 · ready" })).toHaveValue(id);
  expect(screen.getAllByRole("option")).toHaveLength(1);
});

it("submits explicit all-frame intent and reuses the same request ID after an ambiguous failure", async () => {
  getReferences.mockResolvedValue([]);
  startReference
    .mockRejectedValueOnce(new Error("Temporary connection failure"))
    .mockResolvedValueOnce({ id, status: "queued" });
  getReference.mockResolvedValue({ id, status: "queued" });
  show();
  fireEvent.change(screen.getByLabelText("Public Instagram reference"), {
    target: { value: "https://www.instagram.com/reel/abc/" },
  });
  fireEvent.click(screen.getByLabelText("Every-frame grid only"));
  const requestId = screen
    .getByLabelText("Public Instagram reference")
    .closest("form")
    ?.getAttribute("data-reference-request-id");
  fireEvent.click(screen.getByRole("button", { name: "Extract every frame" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary connection failure");
  fireEvent.click(screen.getByRole("button", { name: "Extract every frame" }));
  await waitFor(() => expect(startReference).toHaveBeenCalledTimes(2));
  const first = startReference.mock.calls[0][0].data;
  expect(first).toMatchObject({
    sourceUrl: "https://www.instagram.com/reel/abc/",
    gridOnly: true,
    rightsConfirmed: true,
    requestId,
  });
  expect(startReference.mock.calls[1][0].data.requestId).toBe(first.requestId);
});
