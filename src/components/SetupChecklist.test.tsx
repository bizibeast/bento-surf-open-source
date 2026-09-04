import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupChecklist } from "./SetupChecklist";

vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("SetupChecklist", () => {
  it("opens a six-step guided checklist and sends actions to the editor", () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    render(
      <SetupChecklist
        profileId="creator-1"
        profile={{
          display_name: "",
          bio: "",
          theme: "system",
          accent_color: "sky",
          header_mode: "with_photo",
          pattern: "none",
        }}
        blocks={[]}
        hasPreviewedOrShared={false}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open setup checklist, 0 of 6 complete" }));

    expect(screen.getByRole("heading", { name: "Your setup checklist" })).toBeInTheDocument();
    expect(
      screen.getByText("0 of 6 complete · Your progress saves automatically"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add your name and bio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add your profile photo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a social" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add something important" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Customize your design" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preview and share your Bento" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("flex", "flex-col", "overflow-hidden");
    expect(screen.getByTestId("setup-checklist-scroll-region")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add a social" }));
    fireEvent.click(screen.getByRole("button", { name: "Add social" }));
    act(() => vi.advanceTimersByTime(150));

    expect(onAction).toHaveBeenCalledWith("social");
  });

  it("shows completion and can be permanently dismissed for that creator", () => {
    const props = {
      profileId: "creator-2",
      profile: {
        display_name: "Maya",
        bio: "Creator",
        avatar_url: "https://cdn.example.com/maya.jpg",
        theme: "dark",
      },
      blocks: [{ type: "social_link" }, { type: "commerce" }],
      hasPreviewedOrShared: true,
      onAction: vi.fn(),
    };
    const { unmount } = render(<SetupChecklist {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Open setup checklist, 6 of 6 complete" }));
    expect(screen.getByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to my Bento" }));
    expect(
      screen.queryByRole("button", { name: "Open setup checklist, 6 of 6 complete" }),
    ).toBeNull();

    unmount();
    render(<SetupChecklist {...props} />);
    expect(
      screen.queryByRole("button", { name: "Open setup checklist, 6 of 6 complete" }),
    ).toBeNull();
  });

  it("can skip the checklist before every task is complete", () => {
    const props = {
      profileId: "creator-skip",
      profile: { display_name: "", bio: "" },
      blocks: [],
      hasPreviewedOrShared: false,
      onAction: vi.fn(),
    };
    const { unmount } = render(<SetupChecklist {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Open setup checklist, 0 of 6 complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));

    expect(window.localStorage.getItem("bento:setup-hidden:creator-skip")).toBe("1");
    expect(
      screen.queryByRole("button", { name: "Open setup checklist, 0 of 6 complete" }),
    ).toBeNull();

    unmount();
    render(<SetupChecklist {...props} />);
    expect(
      screen.queryByRole("button", { name: "Open setup checklist, 0 of 6 complete" }),
    ).toBeNull();
  });

  it("opens from the phone dock signal", () => {
    const props = {
      profileId: "creator-phone",
      profile: { display_name: "", bio: "" },
      blocks: [],
      hasPreviewedOrShared: false,
      onAction: vi.fn(),
    };
    const { rerender } = render(<SetupChecklist {...props} openSignal={0} />);

    expect(
      screen.getByRole("button", { name: "Open setup checklist, 0 of 6 complete" }),
    ).toHaveClass("hidden", "sm:flex");

    rerender(<SetupChecklist {...props} openSignal={1} />);

    expect(screen.getByRole("heading", { name: "Your setup checklist" })).toBeInTheDocument();
  });
});
