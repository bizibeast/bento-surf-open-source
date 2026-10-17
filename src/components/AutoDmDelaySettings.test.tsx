import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  get: vi.fn(async () => ({ delaySeconds: 60 })),
  set: vi.fn(async ({ data }: { data: { delaySeconds: number } }) => data),
}));
vi.mock("@/lib/workspace.functions", () => ({
  getWorkspaceSession: async () => ({ workspaceId: "workspace-a" }),
}));
vi.mock("@/lib/auto-dm-delay.functions", () => ({
  getAutoDmDelay: api.get,
  setAutoDmDelay: api.set,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { AutoDmDelaySettings } from "./AutoDmDelaySettings";
afterEach(() => vi.clearAllMocks());
it("shows the persisted setting and keeps all mounted platform controls in sync", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AutoDmDelaySettings />
      <AutoDmDelaySettings />
    </QueryClientProvider>,
  );
  const selectors = screen.getAllByRole("combobox", { name: "Auto DM reply delay" });
  await waitFor(() => expect(selectors[0]).not.toBeDisabled());
  expect(selectors[0]).toHaveValue("60");
  expect(screen.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
    "30",
    "60",
    "120",
    "180",
    "30",
    "60",
    "120",
    "180",
  ]);
  fireEvent.change(selectors[0], { target: { value: "120" } });
  await waitFor(() => expect(selectors[1]).toHaveValue("120"));
  expect(api.set).toHaveBeenCalledExactlyOnceWith({ data: { delaySeconds: 120 } });
  client.clear();
});
