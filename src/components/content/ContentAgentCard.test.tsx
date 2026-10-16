import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentAgentCard as Card } from "@/lib/content-agent";
import { ContentAgentCard } from "./ContentAgentCard";

vi.mock("@/lib/content-agent.functions", () => ({
  attachAgentExport: vi.fn(),
  registerAgentExport: vi.fn(),
  handoffAgentDraft: vi.fn(),
  prepareContentAgentDraft: vi.fn(),
}));
vi.mock("@/lib/upload", () => ({ uploadFileResult: vi.fn() }));
const imageMocks = vi.hoisted(() => ({ state: vi.fn(), photos: vi.fn(), attach: vi.fn() }));
vi.mock("@/lib/content-agent-images.functions", () => ({
  getAgentDraftImages: imageMocks.state,
  getContentImageSettings: async () => ({
    available: false,
    quota: { successful: 0, pending: 0, resetAt: "2026-11-01T00:00:00Z" },
  }),
  getContentExistingPhotos: imageMocks.photos,
  attachAgentDraftImage: imageMocks.attach,
  clearAgentDraftBackgrounds: vi.fn(),
  requestDraftImage: vi.fn(),
}));
beforeEach(() => {
  imageMocks.state.mockResolvedValue({ assets: {}, missingMediaIds: [], jobs: [] });
});
const draft: Card = {
  type: "draft",
  cardId: "draft-1",
  platform: "linkedin",
  format: "post",
  title: "",
  body: "A reviewed LinkedIn post.",
  visualBrief: null,
  sourceUrls: [],
  rationale: "Uses confirmed context.",
};

const schedule: Card = {
  type: "schedule_proposal",
  cardId: "schedule-1",
  draftCardId: "draft-1",
  connectionId: "33333333-3333-4333-8333-333333333333",
  scheduledAt: "2026-09-19T03:30:00.000Z",
  timezone: "Asia/Kolkata",
};

describe("ContentAgentCard", () => {
  it("shows original safe sources on a proactive one-draft payload through copy editing and regeneration", async () => {
    const { storedContentAgentResultSchema } = await import("@/lib/content-agent-proactive");
    const source = "https://publisher.example/original?ref=article";
    const result = storedContentAgentResultSchema.parse({
      action: "draft",
      message: "A sourced draft",
      cards: [
        {
          ...draft,
          sourceUrls: [source],
        },
      ],
      proactive: {
        signalId: "signal",
        signalKey: "key",
        whyNow: "Useful source",
        feedbackActions: [],
      },
    });
    // Historic/external data must also be safe at the render boundary.
    result.cards[0] = {
      ...draft,
      sourceUrls: [
        source,
        "http://archive.example/source",
        "javascript:alert(1)",
        "data:text/html,unsafe",
      ],
    };
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    const onRegenerateDraft = vi.fn().mockResolvedValue(undefined);
    const props = {
      messageId: "message",
      card: result.cards[0],
      allCards: result.cards,
      onApproveBrain: vi.fn(),
      onRejectDraft: vi.fn(),
      onApproveSchedule: vi.fn(),
      onSaveDraft,
      onRegenerateDraft,
    };
    const { rerender } = render(<ContentAgentCard {...props} />);
    expect(screen.getByRole("list", { name: "Draft sources" })).toBeVisible();
    const link = screen.getByRole("link", { name: source });
    expect(link).toHaveAttribute("href", source);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "http://archive.example/source" })).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByText("javascript:alert(1)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.change(screen.getByLabelText("Edit draft"), {
      target: { value: "Revised copy without inline links." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: source })).toBeVisible();
    fireEvent.click(screen.getByText("Improve this draft"));
    fireEvent.change(screen.getByLabelText("Draft feedback"), {
      target: { value: "Tighten the ending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate draft" }));
    await waitFor(() =>
      expect(onRegenerateDraft).toHaveBeenCalledWith("draft-1", "Tighten the ending"),
    );
    rerender(
      <ContentAgentCard
        {...props}
        messageId="regenerated"
        card={{ ...draft, body: "Regenerated copy without inline links.", sourceUrls: [source] }}
      />,
    );
    expect(screen.getByRole("link", { name: source })).toHaveAttribute("href", source);
  });
  it("saves the edited draft before it can be reviewed for scheduling", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    render(
      <ContentAgentCard
        messageId="message"
        card={draft}
        allCards={[draft]}
        onApproveBrain={vi.fn()}
        onRejectDraft={vi.fn()}
        onRegenerateDraft={vi.fn()}
        onApproveSchedule={vi.fn()}
        onSaveDraft={onSaveDraft}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.change(screen.getByLabelText("Edit draft"), { target: { value: "Corrected post." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(onSaveDraft).toHaveBeenCalledWith("draft-1", { body: "Corrected post.", revision: 0 }),
    );
  });
  it("requires review before scheduling a proposed post", () => {
    const onApproveSchedule = vi.fn();
    render(
      <ContentAgentCard
        messageId="22222222-2222-4222-8222-222222222222"
        card={schedule}
        allCards={[draft, schedule]}
        onApproveBrain={vi.fn()}
        onRejectDraft={vi.fn()}
        onRegenerateDraft={vi.fn()}
        onApproveSchedule={onApproveSchedule}
      />,
    );
    expect(onApproveSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Review and schedule"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("A reviewed LinkedIn post.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve schedule" }));
    expect(onApproveSchedule).toHaveBeenCalledWith("draft-1", "schedule-1");
  });

  it("records a bounded reason before rejecting or regenerating a draft", async () => {
    const onRejectDraft = vi.fn();
    const onRegenerateDraft = vi.fn();
    render(
      <ContentAgentCard
        messageId="message"
        card={draft}
        allCards={[draft]}
        onApproveBrain={vi.fn()}
        onRejectDraft={onRejectDraft}
        onRegenerateDraft={onRegenerateDraft}
        onApproveSchedule={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Improve this draft"));
    fireEvent.change(screen.getByLabelText("Draft feedback"), { target: { value: "Too generic" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate draft" }));
    expect(onRegenerateDraft).toHaveBeenCalledWith("draft-1", "Too generic");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reject draft" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    expect(onRejectDraft).toHaveBeenCalledWith("draft-1", "Too generic");
  });
});

it("blocks Instagram handoff without a complete export", () => {
  render(
    <ContentAgentCard
      messageId="message"
      card={{
        ...draft,
        platform: "instagram",
        format: "carousel",
        slides: [
          { heading: "Cover", body: "Promise" },
          { heading: "Action", body: "Try it" },
        ],
      }}
      allCards={[]}
      onApproveBrain={vi.fn()}
      onRejectDraft={vi.fn()}
      onRegenerateDraft={vi.fn()}
      onApproveSchedule={vi.fn()}
    />,
  );
  expect(screen.getByText("Preparing carousel slides")).toBeVisible();
  expect(screen.getByRole("button", { name: "Open in scheduler" })).toBeDisabled();
});
it("starts with latest copy and preserves unsaved edits on refetch and failed save", async () => {
  const props = {
    messageId: "message",
    allCards: [draft],
    onApproveBrain: vi.fn(),
    onRejectDraft: vi.fn(),
    onRegenerateDraft: vi.fn(),
    onApproveSchedule: vi.fn(),
    onSaveDraft: vi.fn().mockRejectedValue(new Error("Conflict")),
  };
  const { rerender } = render(<ContentAgentCard {...props} card={draft} />);
  rerender(
    <ContentAgentCard
      {...props}
      card={{ ...draft, body: "Latest" }}
      draftState={{ revision: 2 }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  expect(screen.getByLabelText("Edit draft")).toHaveValue("Latest");
  fireEvent.change(screen.getByLabelText("Edit draft"), { target: { value: "My unsaved copy" } });
  rerender(
    <ContentAgentCard
      {...props}
      card={{ ...draft, body: "Background" }}
      draftState={{ revision: 3 }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Conflict");
  expect(screen.getByLabelText("Edit draft")).toHaveValue("My unsaved copy");
  expect(props.onSaveDraft).toHaveBeenCalledWith("draft-1", {
    body: "My unsaved copy",
    revision: 2,
  });
});

it.each(["twitter", "linkedin"] as const)(
  "previews a newly attached owned %s photo absent from the message snapshot",
  async (platform) => {
    const base = { ...draft, platform };
    const props = {
      messageId: "message",
      allCards: [base],
      mediaAssets: [],
      onApproveBrain: vi.fn(),
      onRejectDraft: vi.fn(),
      onRegenerateDraft: vi.fn(),
      onApproveSchedule: vi.fn(),
      onDraftChanged: vi.fn(),
    };
    imageMocks.photos.mockResolvedValue([
      { id: "new-photo", url: "https://bento.surf/new-owned.jpg", assessment: "manual" },
    ]);
    const view = render(<ContentAgentCard {...props} card={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Use existing photo" }));
    fireEvent.click(await screen.findByRole("button", { name: /Use this photo/ }));
    await waitFor(() => expect(imageMocks.attach).toHaveBeenCalled());
    imageMocks.state.mockResolvedValue({
      assets: { "new-photo": "https://bento.surf/new-owned.jpg" },
      missingMediaIds: [],
      jobs: [],
    });
    view.rerender(
      <ContentAgentCard
        {...props}
        card={{ ...base, mediaIds: ["new-photo"] }}
        draftState={{ revision: 1 }}
      />,
    );
    expect(
      await screen.findByRole("img", { name: "Currently attached draft image" }),
    ).toHaveAttribute("src", "https://bento.surf/new-owned.jpg");
    expect(screen.getByText("Currently attached image")).toBeVisible();
  },
);

it.each([
  ["youtube", "short_script"],
  ["youtube", "long_script"],
  ["twitter", "thread"],
] as const)("preserves the snapshot still attachment on a retained %s %s", (platform, format) => {
  imageMocks.state.mockClear();
  render(
    <ContentAgentCard
      messageId="message"
      card={{ ...draft, platform, format, mediaIds: ["photo"] }}
      allCards={[]}
      mediaAssets={[
        {
          id: "photo",
          type: "image",
          url: "https://bento.surf/retained.jpg",
          title: "Retained photo",
          caption: "",
          tags: [],
          provider: "upload",
          sourceUrl: null,
        },
      ]}
      onApproveBrain={vi.fn()}
      onRejectDraft={vi.fn()}
      onRegenerateDraft={vi.fn()}
      onApproveSchedule={vi.fn()}
    />,
  );
  expect(screen.getByRole("img", { name: "Retained photo" })).toHaveAttribute(
    "src",
    "https://bento.surf/retained.jpg",
  );
  expect(screen.getByText(draft.body)).toBeVisible();
  expect(imageMocks.state).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Use existing photo" })).not.toBeInTheDocument();
});
