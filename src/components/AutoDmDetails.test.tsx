import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutoDmActivityRow, AutoDmMetrics } from "./AutoDmDetails";
import type { InstagramDmAutomation } from "@/lib/instagram-auto-dm";
const automation: InstagramDmAutomation = {
  id: "a",
  name: "Send the guide",
  connectionId: "c",
  connectionHandle: "bento.surf",
  connectionReady: true,
  connectionNeedsReconnect: false,
  connectionReadinessMessage: null,
  connectionLastVerifiedAt: null,
  triggerType: "comment_keyword",
  keywords: ["guide"],
  excludedKeywords: ["spam"],
  matchType: "contains",
  mediaScope: "specific",
  mediaIds: ["post-1"],
  replyMessage: "Here is your guide",
  publicReplyEnabled: true,
  publicReplyMessages: ["Check your inbox"],
  openingMessage: "Want the guide?",
  confirmationButtonLabel: "Send it",
  emailCaptureEnabled: true,
  emailPromptMessage: "Your email?",
  emailMarketingConsentEnabled: true,
  followGateEnabled: true,
  followPromptMessage: "Follow first",
  followMaxRechecks: 3,
  followFailAction: "withhold",
  replyButtonLabel: "Download",
  replyButtonUrl: "https://example.com/guide",
  enabled: true,
  createdAt: "2026-09-01T00:00:00Z",
  metrics: {
    matched: 120,
    sent: 100,
    failed: 2,
    runs: 70,
    completed: 60,
    confirmations: 65,
    emails: 60,
    follows: 50,
  },
};
describe("Auto-DM details", () => {
  it("opens an activity and its complete related automation flow", () => {
    render(
      <AutoDmActivityRow
        automation={automation}
        event={{
          id: "e",
          automationId: "a",
          automationName: automation.name,
          eventType: "comment",
          eventContext: "comment",
          senderLabel: "@reader",
          matchedKeyword: "guide",
          status: "failed",
          errorMessage: "Token expired",
          createdAt: "2026-09-01T12:00:00Z",
        }}
      />,
    );
    fireEvent.click(screen.getByText("@reader"));
    expect(screen.getByText("Token expired")).toBeVisible();
    fireEvent.click(screen.getByText("View automation: Send the guide"));
    for (const text of [
      "Check your inbox",
      "Want the guide?",
      "Follow first",
      "Your email?",
      "Here is your guide",
    ])
      expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText(/withhold delivery/)).toBeVisible();
  });
  it("shows supplied lifetime counts and never invents link clicks or follower gains", () => {
    render(<AutoDmMetrics automation={automation} />);
    expect(screen.getByText("120")).toBeVisible();
    expect(screen.getByText(/newly gained followers are not tracked/)).toBeVisible();
  });
});
