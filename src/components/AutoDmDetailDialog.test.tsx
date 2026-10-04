import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutoDmDetailActions, AutoDmDetailDialog } from "./AutoDmDetailDialog";

const automation = {
  id: "automation-1",
  name: "Send the guide",
  triggerType: "comment_keyword",
  connectionHandle: "bizibeast",
  matchType: "contains",
  keywords: ["guide"],
  excludedKeywords: [],
  mediaScope: "all",
  mediaIds: [],
  publicReplyEnabled: false,
  publicReplyMessages: [],
  openingMessage: null,
  confirmationButtonLabel: null,
  followGateEnabled: false,
  followPromptMessage: null,
  followMaxRechecks: 0,
  followFailAction: "send",
  emailCaptureEnabled: false,
  emailPromptMessage: null,
  emailMarketingConsentEnabled: false,
  replyMessage: "Here is your guide",
  replyButtonLabel: null,
  replyButtonUrl: null,
  enabled: true,
  connectionReady: true,
  connectionReadinessMessage: null,
  metrics: {
    matched: 12,
    sent: 10,
    failed: 2,
    runs: 10,
    completed: 8,
    confirmations: 4,
    emails: 3,
    follows: 2,
  },
} as never;

describe("AutoDmDetailDialog", () => {
  it("opens stats and flow without expanding the automation card", () => {
    render(<AutoDmDetailActions automation={automation} />);

    fireEvent.click(screen.getByRole("button", { name: "View Stats" }));
    expect(screen.getByRole("dialog", { name: "Automation stats" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "View Automation Flow" }));
    expect(screen.getByRole("dialog", { name: "Automation flow" })).toBeVisible();
  });

  it("keeps stats and automation flow in separate dialogs", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <AutoDmDetailDialog automation={automation} view="stats" onOpenChange={onOpenChange} />,
    );

    expect(screen.getByRole("dialog", { name: "Automation stats" })).toBeVisible();
    expect(screen.getByText("Matched events")).toBeVisible();
    expect(screen.queryByText("Final message")).toBeNull();

    rerender(
      <AutoDmDetailDialog automation={automation} view="flow" onOpenChange={onOpenChange} />,
    );
    expect(screen.getByRole("dialog", { name: "Automation flow" })).toBeVisible();
    expect(screen.getByText("Final message")).toBeVisible();
    expect(screen.queryByText("Matched events")).toBeNull();
  });

  it("closes through the shared view state", () => {
    const onOpenChange = vi.fn();
    render(<AutoDmDetailDialog automation={automation} view="stats" onOpenChange={onOpenChange} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(null);
  });
});
