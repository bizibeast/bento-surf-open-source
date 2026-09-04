import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMyPriorityDmConversationPage,
  getMyPriorityDmInbox,
  markCreatorPriorityDmRead,
  sendCreatorPriorityDmMessage,
  setPriorityDmConversationClosed,
} from "@/lib/priority-dm.functions";

let search = { filter: "open" as "open" | "closed", thread: undefined as string | undefined };
const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => search,
  }),
  Link: ({
    to,
    search: linkSearch,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => {
    const query = linkSearch ? `?${new URLSearchParams(linkSearch).toString()}` : "";
    return (
      <a href={`${to}${query}`} {...props}>
        {children}
      </a>
    );
  },
  useNavigate: () => navigate,
}));

vi.mock("@/lib/priority-dm.functions", () => ({
  getMyPriorityDmConversationPage: vi.fn(),
  getMyPriorityDmInbox: vi.fn(),
  markCreatorPriorityDmRead: vi.fn(),
  sendCreatorPriorityDmMessage: vi.fn(),
  setPriorityDmConversationClosed: vi.fn(),
}));

vi.mock("@/lib/webmcp", () => ({ useWebMcpTools: vi.fn() }));

import { Route } from "./priority-dm";

const PriorityDmInboxPage = (Route as unknown as { component: ComponentType }).component;

const openId = "11111111-1111-4111-8111-111111111111";
const closedId = "22222222-2222-4222-8222-222222222222";
const secondOpenId = "44444444-4444-4444-8444-444444444444";
const base = {
  productId: "33333333-3333-4333-8333-333333333333",
  productTitle: "Launch review",
  buyerEmail: "buyer@example.com",
  creatorName: "Creator",
  creatorUsername: "creator",
  freeFollowUpLimit: 2,
  freeFollowUpsUsed: 1,
  freeFollowUpsRemaining: 1,
  followUpPriceAmount: 900,
  currency: "usd",
  canReply: true,
  readOnlyReason: null,
};
const conversations = [
  {
    ...base,
    id: secondOpenId,
    buyerName: "Second Buyer",
    status: "read" as const,
    lastMessageAt: "2026-08-30T02:30:00.000Z",
    lastMessagePreview: "Another message",
    messages: [
      {
        id: "message-4",
        sender: "buyer" as const,
        body: "Another message",
        createdAt: "2026-08-30T02:30:00.000Z",
      },
    ],
  },
  {
    ...base,
    id: openId,
    buyerName: "Open Buyer",
    status: "unread" as const,
    lastMessageAt: "2026-08-30T03:00:00.000Z",
    lastMessagePreview: "Second message",
    messages: [
      {
        id: "message-2",
        sender: "creator" as const,
        body: "Second message",
        createdAt: "2026-08-30T02:00:00.000Z",
      },
      {
        id: "message-1",
        sender: "buyer" as const,
        body: "First message",
        createdAt: "2026-08-30T01:00:00.000Z",
      },
    ],
  },
  {
    ...base,
    id: closedId,
    buyerName: "Closed Buyer",
    status: "closed" as const,
    lastMessageAt: "2026-08-29T03:00:00.000Z",
    lastMessagePreview: "Closed message",
    canReply: false,
    readOnlyReason: "This conversation is closed.",
    messages: [
      {
        id: "message-3",
        sender: "buyer" as const,
        body: "Closed message",
        createdAt: "2026-08-29T03:00:00.000Z",
      },
    ],
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = () => (
    <QueryClientProvider client={client}>
      <PriorityDmInboxPage />
    </QueryClientProvider>
  );
  const view = render(page());
  return { ...view, client, rerenderPage: () => view.rerender(page()) };
}

describe("Priority DM inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search = { filter: "open", thread: undefined };
    vi.mocked(getMyPriorityDmInbox).mockResolvedValue(conversations);
    vi.mocked(getMyPriorityDmConversationPage).mockImplementation(async (...args) => {
      const { data } = args[0] as { data: { requestId: string } };
      return {
        conversation: conversations.find((conversation) => conversation.id === data.requestId)!,
        nextCursor: null,
      };
    });
    vi.mocked(sendCreatorPriorityDmMessage).mockResolvedValue(conversations[0]);
    vi.mocked(markCreatorPriorityDmRead).mockResolvedValue({ ok: true });
    vi.mocked(setPriorityDmConversationClosed).mockResolvedValue({ ok: true });
  });

  it("links an empty inbox to Priority DM product creation", async () => {
    vi.mocked(getMyPriorityDmInbox).mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByRole("link", { name: "Create a Priority DM product" }),
    ).toHaveAttribute("href", "/store?tab=products&create=priority_dm");
  });

  it("shows only conversations matching the open or closed filter", async () => {
    const { unmount } = renderPage();
    expect(await screen.findByRole("button", { name: /Open Buyer/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Closed Buyer/ })).not.toBeInTheDocument();
    unmount();

    search = { filter: "closed", thread: undefined };
    renderPage();
    expect(await screen.findByRole("button", { name: /Closed Buyer/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open Buyer/ })).not.toBeInTheDocument();
  });

  it("keeps cached conversations visible when a background refresh fails", async () => {
    vi.mocked(getMyPriorityDmInbox).mockRejectedValue(new Error("Network unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["priority-dm"], conversations);

    render(
      <QueryClientProvider client={client}>
        <PriorityDmInboxPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: /Open Buyer/ })).toBeVisible();
    await waitFor(() => expect(getMyPriorityDmInbox).toHaveBeenCalled());
    expect(screen.queryByText("Conversations could not be loaded.")).not.toBeInTheDocument();
  });

  it("keeps a cached cross-filter empty state when a background refresh fails", async () => {
    vi.mocked(getMyPriorityDmInbox).mockRejectedValue(new Error("Network unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["priority-dm"], [conversations[2]]);

    render(
      <QueryClientProvider client={client}>
        <PriorityDmInboxPage />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(client.getQueryState(["priority-dm"])).toMatchObject({
        fetchStatus: "idle",
        status: "error",
      }),
    );
    expect(screen.getByText("No open conversations.")).toBeVisible();
    expect(screen.queryByText("Conversations could not be loaded.")).not.toBeInTheDocument();
  });

  it("includes unread and selected state in conversation row accessibility", async () => {
    search = { filter: "open", thread: openId };
    renderPage();

    expect(
      await screen.findByRole("button", { name: "Unread, Open Buyer, Launch review" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Second Buyer, Launch review" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("renders chronological bubbles and appends a creator message", async () => {
    search = { filter: "open", thread: openId };
    renderPage();

    const thread = await screen.findByRole("region", { name: "Conversation with Open Buyer" });
    const bubbles = within(thread).getAllByTestId("priority-dm-message");
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual([
      expect.stringContaining("First message"),
      expect.stringContaining("Second message"),
    ]);
    fireEvent.change(within(thread).getByLabelText("Reply"), { target: { value: "Thanks" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(sendCreatorPriorityDmMessage).toHaveBeenCalledWith({
        data: { requestId: openId, body: "Thanks" },
      }),
    );
  });

  it("loads only the selected thread and can fetch an earlier message page", async () => {
    const cursor = {
      createdAt: "2026-08-30T01:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    };
    vi.mocked(getMyPriorityDmConversationPage)
      .mockResolvedValueOnce({
        conversation: { ...conversations[1], messages: [conversations[1].messages[1]] },
        nextCursor: cursor,
      })
      .mockResolvedValueOnce({
        conversation: {
          ...conversations[1],
          messages: [
            {
              id: "older-message",
              sender: "buyer",
              body: "Earlier message",
              createdAt: "2026-08-29T01:00:00.000Z",
            },
          ],
        },
        nextCursor: null,
      });
    search = { filter: "open", thread: openId };
    renderPage();

    await waitFor(() =>
      expect(getMyPriorityDmConversationPage).toHaveBeenCalledWith({
        data: { requestId: openId },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() =>
      expect(getMyPriorityDmConversationPage).toHaveBeenLastCalledWith({
        data: { requestId: openId, before: cursor },
      }),
    );
    expect(await screen.findByText("Earlier message")).toBeVisible();
    expect(screen.getByText("First message")).toBeVisible();
  });

  it("marks the selected owned request read and can close or reopen it", async () => {
    search = { filter: "open", thread: openId };
    const { unmount } = renderPage();
    await waitFor(() =>
      expect(markCreatorPriorityDmRead).toHaveBeenCalledWith({
        data: { requestId: openId, lastMessageAt: conversations[1].lastMessageAt },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close conversation" }));
    await waitFor(() =>
      expect(setPriorityDmConversationClosed).toHaveBeenCalledWith({
        data: { requestId: openId, closed: true },
      }),
    );
    unmount();

    search = { filter: "closed", thread: closedId };
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Reopen conversation" }));
    await waitFor(() =>
      expect(setPriorityDmConversationClosed).toHaveBeenCalledWith({
        data: { requestId: closedId, closed: false },
      }),
    );
  });

  it("marks the same thread read again when a later buyer message makes it unread", async () => {
    const readConversations = conversations.map((conversation) =>
      conversation.id === openId ? { ...conversation, status: "read" as const } : conversation,
    );
    vi.mocked(getMyPriorityDmInbox)
      .mockResolvedValueOnce(conversations)
      .mockResolvedValue(readConversations);
    search = { filter: "open", thread: openId };
    const { client } = renderPage();

    await waitFor(() => expect(markCreatorPriorityDmRead).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        client
          .getQueryData<typeof conversations>(["priority-dm"])
          ?.find((conversation) => conversation.id === openId)?.status,
      ).toBe("read"),
    );

    act(() => {
      client.setQueryData(
        ["priority-dm"],
        readConversations.map((conversation) =>
          conversation.id === openId
            ? {
                ...conversation,
                status: "unread" as const,
                lastMessageAt: "2026-08-30T04:00:00.000Z",
                lastMessagePreview: "New buyer message",
              }
            : conversation,
        ),
      );
    });

    await waitFor(() => expect(markCreatorPriorityDmRead).toHaveBeenCalledTimes(2));
    expect(markCreatorPriorityDmRead).toHaveBeenLastCalledWith({
      data: { requestId: openId, lastMessageAt: "2026-08-30T04:00:00.000Z" },
    });
  });

  it("keeps the next thread draft and pending state untouched when an earlier send finishes", async () => {
    let resolveSend!: (value: (typeof conversations)[number]) => void;
    const pendingSend = new Promise<(typeof conversations)[number]>((resolve) => {
      resolveSend = resolve;
    });
    vi.mocked(sendCreatorPriorityDmMessage).mockReturnValue(pendingSend);
    search = { filter: "open", thread: openId };
    const { rerenderPage } = renderPage();
    const firstThread = await screen.findByRole("region", { name: "Conversation with Open Buyer" });
    fireEvent.change(within(firstThread).getByLabelText("Reply"), {
      target: { value: "First draft" },
    });
    fireEvent.click(within(firstThread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(sendCreatorPriorityDmMessage).toHaveBeenCalledOnce());

    search = { filter: "open", thread: secondOpenId };
    rerenderPage();
    const secondThread = await screen.findByRole("region", {
      name: "Conversation with Second Buyer",
    });
    const secondReply = within(secondThread).getByLabelText("Reply");
    fireEvent.change(secondReply, { target: { value: "Second draft" } });
    expect(within(secondThread).getByRole("button", { name: "Send reply" })).not.toBeDisabled();

    await act(async () => {
      resolveSend(conversations[0]);
      await pendingSend;
    });
    await waitFor(() => expect(secondReply).toHaveValue("Second draft"));
  });

  it("keeps newer text typed in the same thread while a send is pending", async () => {
    let resolveSend!: (value: (typeof conversations)[number]) => void;
    const pendingSend = new Promise<(typeof conversations)[number]>((resolve) => {
      resolveSend = resolve;
    });
    vi.mocked(sendCreatorPriorityDmMessage).mockReturnValue(pendingSend);
    search = { filter: "open", thread: openId };
    renderPage();
    const thread = await screen.findByRole("region", { name: "Conversation with Open Buyer" });
    const reply = within(thread).getByLabelText("Reply");
    fireEvent.change(reply, { target: { value: "Submitted draft" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(sendCreatorPriorityDmMessage).toHaveBeenCalledOnce());

    fireEvent.change(reply, { target: { value: "Newer draft" } });
    await act(async () => {
      resolveSend(conversations[1]);
      await pendingSend;
    });

    expect(reply).toHaveValue("Newer draft");
  });

  it("keeps concurrent sends disabled for each request until that request settles", async () => {
    let resolveFirst!: (value: (typeof conversations)[number]) => void;
    let resolveSecond!: (value: (typeof conversations)[number]) => void;
    const firstSend = new Promise<(typeof conversations)[number]>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSend = new Promise<(typeof conversations)[number]>((resolve) => {
      resolveSecond = resolve;
    });
    vi.mocked(sendCreatorPriorityDmMessage)
      .mockReturnValueOnce(firstSend)
      .mockReturnValueOnce(secondSend);
    search = { filter: "open", thread: openId };
    const { rerenderPage } = renderPage();

    const firstThread = await screen.findByRole("region", {
      name: "Conversation with Open Buyer",
    });
    fireEvent.change(within(firstThread).getByLabelText("Reply"), {
      target: { value: "First draft" },
    });
    fireEvent.click(within(firstThread).getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(within(firstThread).getByRole("button", { name: "Send reply" })).toBeDisabled(),
    );

    search = { filter: "open", thread: secondOpenId };
    rerenderPage();
    const secondThread = await screen.findByRole("region", {
      name: "Conversation with Second Buyer",
    });
    fireEvent.change(within(secondThread).getByLabelText("Reply"), {
      target: { value: "Second draft" },
    });
    fireEvent.click(within(secondThread).getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(within(secondThread).getByRole("button", { name: "Send reply" })).toBeDisabled(),
    );
    fireEvent.click(within(secondThread).getByRole("button", { name: "Send reply" }));
    expect(sendCreatorPriorityDmMessage).toHaveBeenCalledTimes(2);

    search = { filter: "open", thread: openId };
    rerenderPage();
    const firstPendingThread = await screen.findByRole("region", {
      name: "Conversation with Open Buyer",
    });
    const firstPendingButton = within(firstPendingThread).getByRole("button", {
      name: "Send reply",
    });
    expect(firstPendingButton).toBeDisabled();
    fireEvent.click(firstPendingButton);
    expect(sendCreatorPriorityDmMessage).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond(conversations[0]);
      await secondSend;
    });
    expect(firstPendingButton).toBeDisabled();
    expect(within(firstPendingThread).getByLabelText("Reply")).toHaveValue("First draft");

    await act(async () => {
      resolveFirst(conversations[1]);
      await firstSend;
    });
    await waitFor(() => expect(within(firstPendingThread).getByLabelText("Reply")).toHaveValue(""));
    fireEvent.change(within(firstPendingThread).getByLabelText("Reply"), {
      target: { value: "Another reply" },
    });
    expect(firstPendingButton).not.toBeDisabled();
  });

  it("does not clear the next selection when an earlier close finishes", async () => {
    let resolveClose!: (value: { ok: true }) => void;
    const pendingClose = new Promise<{ ok: true }>((resolve) => {
      resolveClose = resolve;
    });
    vi.mocked(setPriorityDmConversationClosed).mockReturnValue(pendingClose);
    search = { filter: "open", thread: secondOpenId };
    const { rerenderPage } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Close conversation" }));
    await waitFor(() => expect(setPriorityDmConversationClosed).toHaveBeenCalledOnce());

    search = { filter: "open", thread: openId };
    rerenderPage();
    const nextThread = await screen.findByRole("region", { name: "Conversation with Open Buyer" });
    expect(
      within(nextThread).getByRole("button", { name: "Close conversation" }),
    ).not.toBeDisabled();
    navigate.mockClear();
    const readsBeforeResolve = vi.mocked(getMyPriorityDmInbox).mock.calls.length;

    await act(async () => {
      resolveClose({ ok: true });
      await pendingClose;
    });
    await waitFor(() =>
      expect(vi.mocked(getMyPriorityDmInbox).mock.calls.length).toBeGreaterThan(readsBeforeResolve),
    );
    expect(navigate).not.toHaveBeenCalledWith({
      to: "/priority-dm",
      search: { filter: "open", thread: undefined },
      replace: true,
    });
  });

  it("keeps concurrent closes disabled for each request until that request settles", async () => {
    let resolveFirst!: (value: { ok: true }) => void;
    let resolveSecond!: (value: { ok: true }) => void;
    const firstClose = new Promise<{ ok: true }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondClose = new Promise<{ ok: true }>((resolve) => {
      resolveSecond = resolve;
    });
    vi.mocked(setPriorityDmConversationClosed)
      .mockReturnValueOnce(firstClose)
      .mockReturnValueOnce(secondClose);
    search = { filter: "open", thread: openId };
    const { rerenderPage } = renderPage();

    const firstCloseButton = await screen.findByRole("button", { name: "Close conversation" });
    fireEvent.click(firstCloseButton);
    await waitFor(() => expect(firstCloseButton).toBeDisabled());

    search = { filter: "open", thread: secondOpenId };
    rerenderPage();
    const secondCloseButton = await screen.findByRole("button", { name: "Close conversation" });
    fireEvent.click(secondCloseButton);
    await waitFor(() => expect(secondCloseButton).toBeDisabled());
    fireEvent.click(secondCloseButton);
    expect(setPriorityDmConversationClosed).toHaveBeenCalledTimes(2);

    search = { filter: "open", thread: openId };
    rerenderPage();
    const firstPendingButton = await screen.findByRole("button", {
      name: "Close conversation",
    });
    expect(firstPendingButton).toBeDisabled();
    fireEvent.click(firstPendingButton);
    expect(setPriorityDmConversationClosed).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond({ ok: true });
      await secondClose;
    });
    expect(firstPendingButton).toBeDisabled();

    await act(async () => {
      resolveFirst({ ok: true });
      await firstClose;
    });
    await waitFor(() => expect(firstPendingButton).not.toBeDisabled());
  });

  it("shows an accessible mobile back action for a selected conversation", async () => {
    search = { filter: "open", thread: openId };
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Back to conversations" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/priority-dm",
      search: { filter: "open", thread: undefined },
      replace: true,
    });
  });
});
