import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const state = vi.hoisted(() => ({
  dismissed: new Set<string>(),
  pathname: "/email-marketing",
  ready: false,
  get: vi.fn(),
  save: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => ({ pathname: state.pathname, search: {} }),
}));
vi.mock("sonner", () => ({ toast: { error: state.error } }));
vi.mock("@/lib/onboarding/apps.functions", () => ({
  getAppGuide: state.get,
  setAppGuideDismissed: state.save,
}));
vi.mock("@/components/UpgradeDialog", () => ({ UpgradeDialog: () => <span>Choose a plan</span> }));
vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
import { AppSetupGuide } from "./AppSetupGuide";
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AppSetupGuide workspaceId="workspace" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.dismissed.clear();
  state.pathname = "/email-marketing";
  state.ready = false;
  state.get.mockImplementation(async ({ data }) => ({
    allowed: true,
    readiness: state.ready ? { publication: true, issue: true, published_issue: true } : {},
    complete: state.ready,
    dismissed: state.dismissed.has(data.appId),
    showInitially: !state.dismissed.has(data.appId) && !state.ready,
    context: { audience: "New creators" },
  }));
  state.save.mockImplementation(async ({ data }) => {
    if (data.dismissed) state.dismissed.add(data.appId);
    return { ok: true };
  });
});
describe("per-app setup progress", () => {
  it("does not flash a banner while loading an already-completed guide", async () => {
    state.ready = true;
    const view = mount();
    expect(view.container).toBeEmptyDOMElement();
    await waitFor(() => expect(state.get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.container).toBeEmptyDOMElement();
  });
  it("keeps collapse separate from permanent dismissal", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Use Newsletter below/ }));
    expect(screen.getByRole("button", { name: /Get started with Newsletter/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: /Get started with Newsletter/ }));
    expect(await screen.findByRole("button", { name: /Use Newsletter below/ })).toBeInTheDocument();
    expect(state.save).not.toHaveBeenCalled();
  });
  it("removes a closed guide and keeps it hidden with a fresh query cache", async () => {
    const first = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Newsletter setup guide" }));
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({ data: { appId: "newsletter", dismissed: true } }),
    );
    await waitFor(() => expect(first.container).toBeEmptyDOMElement());
    first.unmount();
    const second = mount();
    expect(second.container).toBeEmptyDOMElement();
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();
    state.pathname = "/store";
    mount();
    expect(
      await screen.findByRole("button", { name: /Get started with Store/ }),
    ).toBeInTheDocument();
  });
  it("can close a collapsed guide without reopening it", async () => {
    state.get.mockResolvedValue({
      allowed: true,
      readiness: {},
      complete: false,
      dismissed: false,
      showInitially: false,
      context: {},
    });
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Newsletter setup guide" }));
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(state.save).toHaveBeenCalledWith({ data: { appId: "newsletter", dismissed: true } });
  });
  it("restores the guide and explains a save failure so dismissal can be retried", async () => {
    state.save.mockRejectedValueOnce(new Error("offline"));
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Newsletter setup guide" }));
    await waitFor(() =>
      expect(state.error).toHaveBeenCalledWith(
        "The guide could not be dismissed. Please try again.",
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Newsletter setup guide" }));
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(state.save).toHaveBeenCalledTimes(2);
  });
  it("removes the guide automatically when rechecking confirms completion", async () => {
    mount();
    expect(await screen.findByText("0/3 ready")).toBeInTheDocument();
    state.ready = true;
    fireEvent.click(screen.getByRole("button", { name: "Check my progress" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Newsletter setup guide" }),
      ).not.toBeInTheDocument(),
    );
  });
});
