import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveNewsletterIssue } from "@/lib/newsletter.functions";
import { scheduleNewsletterIssue, sendAudienceCampaignTest } from "@/lib/commerce-growth.functions";
import { NewsletterWorkspace } from "./NewsletterWorkspace";
import type { NewsletterIssueRecord } from "./NewsletterEditor";

vi.mock("@/lib/newsletter.functions", () => ({ saveNewsletterIssue: vi.fn() }));
vi.mock("@/lib/commerce-growth.functions", () => ({
  scheduleNewsletterIssue: vi.fn(),
  sendAudienceCampaignTest: vi.fn(),
}));

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Studio Notes",
  postal_address: "Bengaluru, India",
  default_template_id: "editorial" as const,
};
const issue: NewsletterIssueRecord = {
  id: "33333333-3333-4333-8333-333333333333",
  publication_id: publication.id,
  list_id: null,
  name: "Launch post",
  subject: "Launch day",
  preview_text: "A first look",
  public_slug: "launch-day",
  web_visibility: "public",
  status: "draft",
  content: [{ id: "1", type: "paragraph", text: "We are live." }],
};

describe("NewsletterWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveNewsletterIssue).mockResolvedValue(issue as never);
  });

  it("test-sends a draft after saving it as a draft", async () => {
    vi.mocked(sendAudienceCampaignTest).mockResolvedValue({ queued: true } as never);
    render(
      <NewsletterWorkspace
        publication={publication}
        issues={[issue]}
        locked={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() =>
      expect(sendAudienceCampaignTest).toHaveBeenCalledWith({
        data: { publicationId: publication.id, id: issue.id, kind: "newsletter" },
      }),
    );
    expect(saveNewsletterIssue).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: issue.id, status: "draft" }),
    });
    expect(scheduleNewsletterIssue).not.toHaveBeenCalled();
  });

  it("saves the exact draft before queueing its scheduled delivery", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(scheduleNewsletterIssue).mockResolvedValue({ queued: 1 } as never);
    render(
      <NewsletterWorkspace
        publication={publication}
        issues={[issue]}
        locked={false}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "2030-01-02T03:04" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() =>
      expect(scheduleNewsletterIssue).toHaveBeenCalledWith({
        data: {
          id: issue.id,
          publicationId: publication.id,
          publish: true,
          scheduledAt: new Date("2030-01-02T03:04").toISOString(),
        },
      }),
    );
    expect(saveNewsletterIssue).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: issue.id, status: "draft" }),
    });
  });

  it("keeps legacy publication and paid forms out of Write", () => {
    render(
      <NewsletterWorkspace
        publication={publication}
        issues={[issue]}
        locked={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Publishing steps" })).toBeVisible();
    expect(screen.queryByLabelText("Publication name")).toBeNull();
    expect(screen.queryByLabelText("Paid price")).toBeNull();
  });

  it("shows published posts as read-only history", () => {
    render(
      <NewsletterWorkspace
        publication={publication}
        issues={[
          {
            ...issue,
            status: "published",
            content: [{ id: "1", type: "heading", text: "Release notes" }],
          },
        ]}
        locked={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent("Release notes");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});
