import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveAudienceCampaign,
  sendAudienceCampaign,
  sendAudienceCampaignTest,
} from "@/lib/commerce-growth.functions";
import { EmailBroadcastsPanel } from "./EmailBroadcastsPanel";

vi.mock("@/lib/commerce-growth.functions", () => ({
  deleteAudienceCampaign: vi.fn(),
  saveAudienceCampaign: vi.fn(),
  sendAudienceCampaign: vi.fn(),
  sendAudienceCampaignTest: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("EmailBroadcastsPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses authoritative publication recipient counts in its semantic table", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          publicationId="33333333-3333-4333-8333-333333333333"
          campaigns={
            [
              {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Launch",
                subject: "Launch",
                list_id: null,
                status: "draft",
              },
            ] as never
          }
          lists={[]}
          contacts={[]}
          recipientCounts={{ all: 7 }}
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("table", { name: "Broadcasts" })).toBeVisible();
    expect(screen.getByText("7 subscribed recipients")).toBeVisible();
  });

  it("offers explicit send-now and ISO schedule actions for a draft", async () => {
    vi.mocked(sendAudienceCampaign).mockResolvedValue({ queued: 1, scheduledAt: null } as never);
    const campaign = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Launch",
      subject: "Launch day",
      list_id: null,
      status: "draft",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          campaigns={[campaign] as never}
          lists={[]}
          contacts={[{ marketing_status: "subscribed" }] as never}
          publicationId="33333333-3333-4333-8333-333333333333"
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(screen.getByRole("button", { name: "New broadcast" })).toBeEnabled();
    expect(screen.queryByLabelText("Post name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(sendAudienceCampaign).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(sendAudienceCampaign).toHaveBeenCalledWith({
        data: {
          publicationId: "33333333-3333-4333-8333-333333333333",
          id: campaign.id,
          scheduledAt: null,
        },
      }),
    );

    const localTime = "2030-01-02T03:04";
    fireEvent.change(screen.getByLabelText("Schedule Launch"), { target: { value: localTime } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() =>
      expect(sendAudienceCampaign).toHaveBeenLastCalledWith({
        data: {
          publicationId: "33333333-3333-4333-8333-333333333333",
          id: campaign.id,
          scheduledAt: new Date(localTime).toISOString(),
        },
      }),
    );
  });

  it("reopens structured drafts, shows the selected-list count, and test-sends to the creator", async () => {
    vi.mocked(saveAudienceCampaign).mockResolvedValue({ id: "campaign-1" } as never);
    vi.mocked(sendAudienceCampaignTest).mockResolvedValue({ queued: true } as never);
    const campaign = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Launch",
      subject: "Launch day",
      preview_text: "A preview",
      body_markdown: "Structured body",
      content: [{ id: "1", type: "paragraph", text: "Structured body" }],
      sender_postal_address: "123 Studio Road, Bengaluru",
      list_id: "22222222-2222-4222-8222-222222222222",
      status: "draft",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          campaigns={[campaign] as never}
          lists={
            [
              {
                id: campaign.list_id,
                name: "Launch list",
              },
            ] as never
          }
          contacts={
            [
              { id: "contact-1", marketing_status: "subscribed" },
              { id: "contact-2", marketing_status: "subscribed" },
            ] as never
          }
          listMembers={[{ list_id: campaign.list_id, contact_id: "contact-1" }]}
          publicationId="33333333-3333-4333-8333-333333333333"
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("1 subscribed recipient")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Launch" }));
    expect(screen.getByLabelText("Post name")).toHaveValue("Launch");
    expect(screen.getByLabelText("Paragraph text 1")).toHaveValue("Structured body");
    const sendTest = screen
      .getAllByRole("button", { name: "Send test" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    expect(sendTest).toBeDefined();
    fireEvent.click(sendTest!);
    await waitFor(() =>
      expect(sendAudienceCampaignTest).toHaveBeenCalledWith({
        data: { publicationId: "33333333-3333-4333-8333-333333333333", id: "campaign-1" },
      }),
    );
  });

  it("saves the current document, list, and postal address before awaiting a test send", async () => {
    vi.mocked(saveAudienceCampaign).mockResolvedValue({ id: "saved-campaign" } as never);
    vi.mocked(sendAudienceCampaignTest).mockRejectedValue(new Error("Test provider unavailable"));
    const campaign = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Launch",
      subject: "Launch day",
      preview_text: "A preview",
      body_markdown: "Old body",
      content: [{ id: "1", type: "paragraph", text: "Old body" }],
      sender_postal_address: "Old address",
      list_id: null,
      status: "draft",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          campaigns={[campaign] as never}
          lists={[{ id: "vip-list", name: "VIP readers" }] as never}
          contacts={[]}
          publicationId="33333333-3333-4333-8333-333333333333"
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Launch" }));
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "vip-list" } });
    fireEvent.change(screen.getByLabelText("Sender postal address"), {
      target: { value: "New postal address" },
    });
    fireEvent.change(screen.getByLabelText("Paragraph text 1"), {
      target: { value: "Current body" },
    });
    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Send test" })
        .find((button) => !(button as HTMLButtonElement).disabled)!,
    );

    await waitFor(() => expect(screen.getByText("Test provider unavailable")).toBeVisible());
    expect(saveAudienceCampaign).toHaveBeenCalledWith({
      data: expect.objectContaining({
        publicationId: "33333333-3333-4333-8333-333333333333",
        id: campaign.id,
        listId: "vip-list",
        postalAddress: "New postal address",
        content: [{ id: "1", type: "paragraph", text: "Current body" }],
      }),
    });
    expect(sendAudienceCampaignTest).toHaveBeenCalledWith({
      data: {
        publicationId: "33333333-3333-4333-8333-333333333333",
        id: "saved-campaign",
      },
    });
    expect(vi.mocked(saveAudienceCampaign).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendAudienceCampaignTest).mock.invocationCallOrder[0],
    );
    expect(screen.queryByText("Test email sent")).toBeNull();
  });

  it("confirms the exact selected audience and reports publish rejection only after the server", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(saveAudienceCampaign).mockResolvedValue({ id: "saved-campaign" } as never);
    vi.mocked(sendAudienceCampaign).mockRejectedValue(new Error("Broadcast queue unavailable"));
    const campaign = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Launch",
      subject: "Launch day",
      preview_text: "A preview",
      body_markdown: "Body",
      content: [{ id: "1", type: "paragraph", text: "Body" }],
      sender_postal_address: "Old address",
      list_id: null,
      status: "draft",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          publicationId="33333333-3333-4333-8333-333333333333"
          publicationName="Studio Notes"
          campaigns={[campaign] as never}
          lists={[{ id: "vip-list", name: "VIP readers" }] as never}
          contacts={[]}
          recipientCounts={{ "vip-list": 3, all: 9 }}
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Launch" }));
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "vip-list" } });
    fireEvent.change(screen.getByLabelText("Sender postal address"), {
      target: { value: "Publish postal address" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send broadcast" }));

    expect(window.confirm).toHaveBeenCalledWith(
      'Send "Launch" in Studio Notes?\nTarget: VIP readers · 3 recipients\nAccess: Email only\nSchedule: Immediately',
    );
    await waitFor(() => expect(screen.getByText("Broadcast queue unavailable")).toBeVisible());
    expect(saveAudienceCampaign).toHaveBeenCalledWith({
      data: expect.objectContaining({
        listId: "vip-list",
        postalAddress: "Publish postal address",
      }),
    });
    expect(sendAudienceCampaign).toHaveBeenCalledWith({
      data: {
        publicationId: "33333333-3333-4333-8333-333333333333",
        id: "saved-campaign",
        scheduledAt: null,
      },
    });
    expect(screen.queryByText("Post published")).toBeNull();
  });

  it("shows publish success only after the server promise resolves", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(saveAudienceCampaign).mockResolvedValue({ id: "saved-campaign" } as never);
    let resolveSend!: (value: unknown) => void;
    vi.mocked(sendAudienceCampaign).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }) as never,
    );
    const campaign = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Launch",
      subject: "Launch day",
      preview_text: "A preview",
      body_markdown: "Body",
      content: [{ id: "1", type: "paragraph", text: "Body" }],
      sender_postal_address: "123 Studio Road",
      list_id: null,
      status: "draft",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          publicationId="33333333-3333-4333-8333-333333333333"
          publicationName="Studio Notes"
          campaigns={[campaign] as never}
          lists={[]}
          contacts={[]}
          recipientCounts={{ all: 1 }}
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Launch" }));
    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send broadcast" }));
    await waitFor(() => expect(sendAudienceCampaign).toHaveBeenCalled());
    expect(screen.queryByText("Broadcast queued")).toBeNull();
    resolveSend({ queued: 1, scheduledAt: null });
    expect(await screen.findByText("Broadcast queued")).toBeVisible();
  });

  it("shows the actual sent state without disguising it as queued", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          campaigns={
            [
              {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Launch",
                subject: "Launch day",
                list_id: null,
                status: "sent",
              },
            ] as never
          }
          lists={[]}
          contacts={[]}
          publicationId="33333333-3333-4333-8333-333333333333"
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("sent")).toBeVisible();
    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("requeues a failed broadcast through the shared retry action", async () => {
    vi.mocked(sendAudienceCampaign).mockResolvedValue({ queued: 1, scheduledAt: null } as never);
    const campaign = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Launch",
      subject: "Launch day",
      list_id: null,
      status: "failed",
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EmailBroadcastsPanel
          campaigns={[campaign] as never}
          lists={[]}
          contacts={[{ marketing_status: "subscribed" }] as never}
          publicationId="33333333-3333-4333-8333-333333333333"
          locked={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() =>
      expect(sendAudienceCampaign).toHaveBeenCalledWith({
        data: {
          publicationId: "33333333-3333-4333-8333-333333333333",
          id: campaign.id,
          scheduledAt: null,
        },
      }),
    );
  });
});
