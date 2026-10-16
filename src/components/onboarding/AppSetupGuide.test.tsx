import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const state = vi.hoisted(() => ({ dismissed: false, ready: false, get: vi.fn(), save: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => ({ pathname: "/email-marketing", search: {} }),
}));
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
  state.dismissed = false;
  state.ready = false;
  state.get.mockImplementation(async () => ({
    allowed: true,
    readiness: state.ready ? { publication: true, issue: true, published_issue: true } : {},
    complete: state.ready,
    dismissed: state.dismissed,
    showInitially: !state.dismissed && !state.ready,
    context: { audience: "New creators" },
  }));
  state.save.mockImplementation(async ({ data }) => {
    state.dismissed = data.dismissed;
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
  it("saves dismissal, stays collapsed on resume and can be reopened", async () => {
    const first = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Use Newsletter below/ }));
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({ data: { appId: "newsletter", dismissed: true } }),
    );
    first.unmount();
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Get started with Newsletter/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Get started with Newsletter/ }));
    expect(await screen.findByRole("button", { name: /Use Newsletter below/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(state.save).toHaveBeenLastCalledWith({
        data: { appId: "newsletter", dismissed: false },
      }),
    );
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
