import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCustomerLibraryLink,
  getCustomerLibrary,
  requestCustomerLibraryLink,
} from "@/lib/customer-library.functions";
import { createCommerceCheckout } from "@/lib/commerce.functions";
import { getCustomerPriorityDm, sendCustomerPriorityDmMessage } from "@/lib/priority-dm.functions";
import { toast } from "sonner";

const requestId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const returnTo = `/library/priority-dm/${requestId}`;

const routeState = vi.hoisted(() => ({
  params: { requestId: "11111111-1111-4111-8111-111111111111" },
  search: { returnTo: "/library" },
  loaderData: {} as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useLoaderData: () => routeState.loaderData,
    useParams: () => routeState.params,
    useSearch: () => routeState.search,
  }),
  Link: ({
    to,
    search,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => {
    const query = search ? `?${new URLSearchParams(search).toString()}` : "";
    return (
      <a href={`${to}${query}`} {...props}>
        {children}
      </a>
    );
  },
  redirect: (options: Record<string, unknown>) => {
    throw { redirect: options };
  },
}));

vi.mock("@/lib/customer-library.functions", () => ({
  consumeCustomerLibraryLink: vi.fn(),
  createCustomerLibraryAccess: vi.fn(),
  getCustomerLibrary: vi.fn(),
  logoutCustomerLibrary: vi.fn(),
  requestCustomerLibraryLink: vi.fn(),
}));

vi.mock("@/lib/commerce.functions", () => ({ createCommerceCheckout: vi.fn() }));

vi.mock("@/lib/priority-dm.functions", () => ({
  getCustomerPriorityDm: vi.fn(),
  sendCustomerPriorityDmMessage: vi.fn(),
}));

vi.mock("@/lib/webmcp", () => ({
  handleWebMcpFormSubmit: (
    event: { preventDefault: () => void },
    submit: () => Promise<unknown>,
  ) => {
    event.preventDefault();
    return submit();
  },
  requireWebMcpUserConfirmation: vi.fn(),
  useWebMcpTools: vi.fn(),
  webMcpResult: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { Route as BuyerRoute } from "./library.priority-dm.$requestId";
import { Route as LibraryRoute } from "./library.index";
import { Route as VerifyRoute } from "./library.verify";

const BuyerPage = (BuyerRoute as unknown as { component: ComponentType }).component;

afterEach(() => vi.unstubAllGlobals());

const readyConversation = {
  id: requestId,
  productId,
  productTitle: "Launch review",
  buyerName: "Maya",
  buyerEmail: "another-buyer@example.com",
  creatorName: "Ari",
  creatorUsername: "ari",
  status: "read" as const,
  freeFollowUpLimit: 2,
  freeFollowUpsUsed: 1,
  freeFollowUpsRemaining: 1,
  followUpPriceAmount: 900,
  currency: "usd",
  lastMessageAt: "2026-08-30T10:00:00.000Z",
  lastMessagePreview: "Second message",
  canReply: true,
  readOnlyReason: null,
  messages: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      sender: "creator" as const,
      body: "Second message",
      createdAt: "2026-08-30T10:00:00.000Z",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      sender: "buyer" as const,
      body: "First message",
      createdAt: "2026-08-30T09:00:00.000Z",
    },
  ],
};

function renderBuyer(loaderData = routeState.loaderData) {
  routeState.loaderData = loaderData;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <BuyerPage />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function stubLocationAssign() {
  const assign = vi.fn();
  const browserWindow = Object.create(window) as Window;
  Object.defineProperty(browserWindow, "location", { value: { assign } });
  vi.stubGlobal("window", browserWindow);
  return assign;
}

describe("buyer Priority DM conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeState.params = { requestId };
    routeState.search = { returnTo: "/library" };
    vi.mocked(getCustomerLibrary).mockResolvedValue({
      customer: { email: "maya@example.com", name: "Maya" },
      entries: [],
    });
    vi.mocked(getCustomerPriorityDm).mockResolvedValue(readyConversation);
    vi.mocked(sendCustomerPriorityDmMessage).mockResolvedValue(readyConversation);
    vi.mocked(requestCustomerLibraryLink).mockResolvedValue({ ok: true });
  });

  it("uses the existing passwordless form with the exact conversation return path", async () => {
    renderBuyer({ state: "signed-out" });

    fireEvent.change(screen.getByLabelText("Checkout email"), {
      target: { value: "maya@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Email my sign-in link" }));

    await waitFor(() =>
      expect(requestCustomerLibraryLink).toHaveBeenCalledWith({
        data: { email: "maya@example.com", returnTo },
      }),
    );
  });

  it("renders the same generic unavailable state without conversation or buyer data", () => {
    renderBuyer({ state: "unavailable" });

    expect(
      screen.getByRole("heading", { name: "This conversation is unavailable." }),
    ).toBeVisible();
    expect(screen.queryByText("Launch review")).not.toBeInTheDocument();
    expect(screen.queryByText("another-buyer@example.com")).not.toBeInTheDocument();
  });

  it("shows chronological bubbles, creator identity, product, and remaining free replies", () => {
    renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: readyConversation,
    });

    expect(screen.getByRole("heading", { name: "Ari" })).toBeVisible();
    expect(screen.getByText("Launch review")).toBeVisible();
    expect(screen.getByText("1 free reply remaining")).toBeVisible();
    const bubbles = screen.getAllByTestId("priority-dm-message");
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual([
      expect.stringContaining("First message"),
      expect.stringContaining("Second message"),
    ]);
    expect(screen.queryByText("another-buyer@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Conversation with Ari" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("sends an included reply and invalidates the owned conversation query", async () => {
    const { client } = renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: readyConversation,
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "One more thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(sendCustomerPriorityDmMessage).toHaveBeenCalledWith({
        data: { requestId, body: "One more thing" },
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["customer-priority-dm", requestId],
      }),
    );
  });

  it("keeps the draft and refreshes the thread when an included reply fails", async () => {
    vi.mocked(sendCustomerPriorityDmMessage).mockRejectedValue(new Error("Allowance changed"));
    const { client } = renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: readyConversation,
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const reply = screen.getByLabelText("Reply");

    fireEvent.change(reply, { target: { value: "One more thing" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["customer-priority-dm", requestId],
      }),
    );
    expect(reply).toHaveValue("One more thing");
  });

  it("keeps a newer draft when an earlier included reply finishes", async () => {
    let resolveSend!: (value: typeof readyConversation) => void;
    vi.mocked(sendCustomerPriorityDmMessage).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    const { client } = renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: readyConversation,
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const reply = screen.getByLabelText("Reply");

    fireEvent.change(reply, { target: { value: "First reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(sendCustomerPriorityDmMessage).toHaveBeenCalledTimes(1));

    fireEvent.change(reply, { target: { value: "Second reply" } });
    await act(async () => resolveSend(readyConversation));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["customer-priority-dm", requestId],
      }),
    );
    expect(reply).toHaveValue("Second reply");
  });

  it("keeps the typed paid reply while checkout starts with the server-owned request", async () => {
    vi.mocked(createCommerceCheckout).mockReturnValue(new Promise(() => {}));
    renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: { ...readyConversation, freeFollowUpsUsed: 2, freeFollowUpsRemaining: 0 },
    });

    const reply = screen.getByLabelText("Reply");
    fireEvent.change(reply, { target: { value: "Paid follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay $9 to reply" }));

    await waitFor(() =>
      expect(createCommerceCheckout).toHaveBeenCalledWith({
        data: {
          productId,
          priorityDmRequestId: requestId,
          email: "maya@example.com",
          name: "Maya",
          recordingAddon: false,
          answers: { priority_message: "Paid follow-up" },
          attribution: {},
        },
      }),
    );
    expect(reply).toHaveValue("Paid follow-up");
  });

  it("validates and navigates to a resolved paid checkout URL", async () => {
    const assign = stubLocationAssign();
    vi.mocked(createCommerceCheckout).mockResolvedValue({
      url: "https://checkout.example.com/pay/session-1",
      test: false,
    });
    renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: { ...readyConversation, freeFollowUpsUsed: 2, freeFollowUpsRemaining: 0 },
    });

    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Paid follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay $9 to reply" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://checkout.example.com/pay/session-1"),
    );
  });

  it("rejects an unsafe resolved paid checkout URL", async () => {
    const assign = stubLocationAssign();
    vi.mocked(createCommerceCheckout).mockResolvedValue({
      url: "javascript:alert(1)",
      test: false,
    });
    renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: { ...readyConversation, freeFollowUpsUsed: 2, freeFollowUpsRemaining: 0 },
    });

    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Paid follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay $9 to reply" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Checkout returned an invalid destination."),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["closed", "This conversation is closed."],
    ["refunded", "This purchase is no longer eligible for replies."],
    ["disputed", "This purchase is no longer eligible for replies."],
  ])("keeps %s history readable without a composer", (_state, readOnlyReason) => {
    renderBuyer({
      state: "ready",
      customer: { email: "maya@example.com", name: "Maya" },
      conversation: {
        ...readyConversation,
        status: _state === "closed" ? "closed" : "read",
        canReply: false,
        readOnlyReason,
      },
    });

    expect(screen.getByText("First message")).toBeVisible();
    expect(screen.getByText(readOnlyReason)).toBeVisible();
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
  });
});

describe("customer library conversation return path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeState.search = { returnTo: "/library" };
  });

  it("sanitizes library and verification return destinations", () => {
    type SearchParser = { parse: (input: unknown) => { returnTo: string } };
    const parseLibrary = (LibraryRoute as unknown as { validateSearch: SearchParser })
      .validateSearch.parse;
    const parseVerify = (VerifyRoute as unknown as { validateSearch: SearchParser }).validateSearch
      .parse;

    expect(parseLibrary({ returnTo })).toMatchObject({ returnTo });
    expect(parseLibrary({ returnTo: "https://evil.test" })).toMatchObject({
      returnTo: "/library",
    });
    expect(parseVerify({ token: "x".repeat(32), returnTo })).toMatchObject({ returnTo });
    expect(parseVerify({ token: "x".repeat(32), returnTo: "/store" })).toMatchObject({
      returnTo: "/library",
    });
  });

  it("redirects a consumed link only to its sanitized Priority DM path", async () => {
    vi.mocked(consumeCustomerLibraryLink).mockResolvedValue({ ok: true });
    const loader = (
      VerifyRoute as unknown as {
        loader: (input: { deps: { token: string; returnTo: string } }) => Promise<unknown>;
      }
    ).loader;

    await expect(loader({ deps: { token: "x".repeat(32), returnTo } })).rejects.toEqual({
      redirect: { href: returnTo },
    });
  });

  it("keeps the safe return path on an expired link's request-new-link action", () => {
    routeState.search = { token: "expired", returnTo } as never;
    const InvalidLink = (VerifyRoute as unknown as { component: ComponentType }).component;

    render(<InvalidLink />);

    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute(
      "href",
      `/library?returnTo=${encodeURIComponent(returnTo)}`,
    );
  });
});
