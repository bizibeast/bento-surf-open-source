import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeaturebaseHub } from "./FeaturebaseHub";

const { showNewMessage, captureProductEvent, onUnreadCountChange, whenReady } = vi.hoisted(() => ({
  showNewMessage: vi.fn(),
  captureProductEvent: vi.fn(),
  onUnreadCountChange: vi.fn((callback: (count: number) => void) => callback(3)),
  whenReady: vi.fn((callback: () => void) => callback()),
}));

vi.mock("featurebase-js", () => ({
  onUnreadCountChange,
  showNewMessage,
  whenReady,
}));

vi.mock("@/lib/posthog", () => ({ captureProductEvent }));

describe("FeaturebaseHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.querySelectorAll("#fb-messenger-root").forEach((element) => element.remove());
    const messengerRoot = document.createElement("div");
    messengerRoot.id = "fb-messenger-root";
    document.body.appendChild(messengerRoot);
  });

  it("does not show or initialize the hub without a configured portal", () => {
    render(<FeaturebaseHub portalUrl={null} />);

    expect(screen.queryByRole("button", { name: "Help, feedback and updates" })).toBeNull();
    expect(whenReady).not.toHaveBeenCalled();
  });

  it("keeps the launcher inside the app header on mobile", () => {
    render(<FeaturebaseHub portalUrl="https://feedback.example" inAppShell />);

    expect(
      screen.getByRole("button", { name: "Help, feedback and updates" }).parentElement,
    ).toHaveClass("right-3", "top-1", "lg:bottom-5", "lg:top-auto");
  });

  it("offers support, feedback, updates, docs, and roadmap from one launcher", async () => {
    const user = userEvent.setup();
    render(<FeaturebaseHub portalUrl="https://feedback.example" />);

    expect(screen.getByText("3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Help, feedback and updates" }));
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[var(--radix-popover-content-available-height)]",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(screen.getByRole("link", { name: /Contact support/ })).toHaveAttribute(
      "href",
      "https://feedback.example",
    );
    expect(screen.getByRole("link", { name: /Contact support/ })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: /Share feedback/ })).toHaveAttribute(
      "href",
      "https://feedback.example",
    );
    expect(screen.getByRole("link", { name: /Share feedback/ })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: /Help center/ })).toHaveAttribute(
      "href",
      "https://feedback.example",
    );
    expect(screen.getByRole("link", { name: /Roadmap/ })).toHaveAttribute(
      "href",
      "https://feedback.example/roadmap",
    );

    await user.click(screen.getByRole("link", { name: /Contact support/ }));
    expect(showNewMessage).toHaveBeenCalledOnce();
    expect(captureProductEvent).toHaveBeenCalledWith("support_messenger_opened");

    await user.click(screen.getByRole("button", { name: "Help, feedback and updates" }));
    await user.click(screen.getByRole("link", { name: /Share feedback/ }));
    expect(captureProductEvent).toHaveBeenCalledWith("feedback_portal_opened");

    await user.click(screen.getByRole("button", { name: "Help, feedback and updates" }));
    expect(screen.getByRole("link", { name: /Product updates/ })).toHaveAttribute(
      "href",
      "https://feedback.example/changelog",
    );
    expect(screen.getByRole("link", { name: /Product updates/ })).toHaveAttribute(
      "target",
      "_blank",
    );
    await user.click(screen.getByRole("link", { name: /Product updates/ }));
    expect(captureProductEvent).toHaveBeenCalledWith("product_updates_opened");
  });

  it("keeps a working portal fallback when the Messenger runtime is blocked", async () => {
    whenReady.mockImplementationOnce(() => undefined);
    document.getElementById("fb-messenger-root")?.remove();
    const user = userEvent.setup();
    render(<FeaturebaseHub portalUrl="https://feedback.example" />);

    await user.click(screen.getByRole("button", { name: "Help, feedback and updates" }));
    const contactSupport = screen.getByRole("link", { name: /Contact support/ });
    await user.click(contactSupport);

    expect(showNewMessage).not.toHaveBeenCalled();
    expect(captureProductEvent).toHaveBeenCalledWith("support_messenger_opened");
    expect(captureProductEvent).toHaveBeenCalledWith("support_portal_fallback_opened");
    expect(contactSupport).toHaveAttribute("href", "https://feedback.example");
  });

  it("keeps the creator shell usable when Featurebase readiness throws", () => {
    whenReady.mockImplementationOnce(() => {
      throw new Error("blocked by browser");
    });

    expect(() => render(<FeaturebaseHub portalUrl="https://feedback.example" />)).not.toThrow();
    expect(screen.getByRole("button", { name: "Help, feedback and updates" })).toBeInTheDocument();
  });

  it("falls back safely when unread subscription fails after readiness", () => {
    onUnreadCountChange.mockImplementationOnce(() => {
      throw new Error("runtime unavailable");
    });

    expect(() => render(<FeaturebaseHub portalUrl="https://feedback.example" />)).not.toThrow();
    expect(screen.getByRole("button", { name: "Help, feedback and updates" })).toBeInTheDocument();
  });
});
