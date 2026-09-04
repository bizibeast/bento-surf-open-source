import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentPropsWithoutRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailAudiencePanel } from "./EmailAudiencePanel";

const mocks = vi.hoisted(() => ({
  archiveAudienceContacts: vi.fn().mockResolvedValue({ transitioned: 1 }),
  createAudienceList: vi.fn(),
  deleteAudienceList: vi.fn(),
  getPublicationAudience: vi.fn(),
  setAudienceListMember: vi.fn(),
  unsubscribePublicationSubscribers: vi.fn().mockResolvedValue({ unsubscribed: 1 }),
}));

vi.mock("@/lib/commerce-growth.functions", () => mocks);
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    ...props
  }: ComponentPropsWithoutRef<"a"> & { to: string; search?: { section?: string } }) => (
    <a href={`${to}${search?.section ? `?section=${search.section}` : ""}`} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Studio Notes",
};
const contact = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "reader@example.com",
  name: "Reader",
  marketing_status: "subscribed",
  last_seen_at: "2026-08-31T00:00:00.000Z",
  last_source: "newsletter_signup",
  subscription_id: "33333333-3333-4333-8333-333333333333",
  subscription_status: "pending",
  email_enabled: true,
  source: "csv_import",
  joined_at: "2026-08-30T00:00:00.000Z",
  paid_access: false,
};
const list = {
  id: "44444444-4444-4444-8444-444444444444",
  creator_id: "55555555-5555-4555-8555-555555555555",
  publication_id: publication.id,
  name: "Founders",
  description: "",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

function page(input: Partial<Record<string, unknown>> = {}) {
  return {
    subscribers: [contact],
    contactUsage: {
      plan: "creator",
      limit: 500,
      subscribed: 482,
      remaining: 18,
      overLimit: false,
    },
    nextCursor: null,
    ...input,
  } as never;
}

function renderPanel(locked = false) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <EmailAudiencePanel
        publication={publication}
        lists={[list]}
        listMembers={[{ list_id: list.id, contact_id: contact.id }]}
        locked={locked}
        onRefresh={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("EmailAudiencePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicationAudience.mockReset().mockResolvedValue(page());
  });

  it("renders selected-publication subscribers in a semantic table", async () => {
    renderPanel();

    const table = await screen.findByRole("table", { name: "Studio Notes audience" });
    for (const heading of [
      "Email",
      "Name",
      "Status",
      "Lists",
      "Source",
      "Joined",
      "Paid access",
      "Actions",
    ]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeVisible();
    }
    expect(within(table).getByText("reader@example.com")).toBeVisible();
    expect(within(table).getByRole("button", { name: /Founders/ })).toBeVisible();
    expect(within(table).getByText("No")).toBeVisible();
    expect(
      screen.getByText("482 / 500 marketing contacts; customers remain visible below"),
    ).toBeVisible();
    expect(screen.queryByText("People on this page")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(mocks.getPublicationAudience).toHaveBeenCalledWith({
      data: {
        publicationId: publication.id,
        query: "",
        status: "all",
        listId: undefined,
        joinedFrom: undefined,
        joinedTo: undefined,
        sortDirection: "desc",
        cursor: undefined,
      },
    });
  });

  it("keeps publication filters available and resets pagination when they change", async () => {
    const user = userEvent.setup();
    mocks.getPublicationAudience
      .mockResolvedValueOnce(
        page({
          nextCursor: { joinedAt: "2026-08-30T00:00:00.000Z", id: contact.subscription_id },
        }),
      )
      .mockResolvedValue(page({ subscribers: [] }));
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Joined" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("searchbox", { name: "Search subscribers" }), "absent");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Subscription status" }),
      "unsubscribed",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Subscriber list" }), list.id);
    await user.type(screen.getByLabelText("Joined after"), "2026-08-01");
    await user.type(screen.getByLabelText("Joined before"), "2026-08-31");

    expect(await screen.findByText("No audience contacts match these filters.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await waitFor(() =>
      expect(mocks.getPublicationAudience).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          publicationId: publication.id,
          query: "absent",
          status: "unsubscribed",
          listId: list.id,
          joinedFrom: "2026-08-01",
          joinedTo: "2026-08-31",
          sortDirection: "asc",
          cursor: undefined,
        }),
      }),
    );
  });

  it("retains cursor pagination when only the cursor timestamp changes", async () => {
    const user = userEvent.setup();
    const firstCursor = {
      joinedAt: "2026-08-30T00:00:00.000Z",
      id: contact.subscription_id,
    };
    const secondCursor = {
      joinedAt: "2026-08-29T00:00:00.000Z",
      id: contact.subscription_id,
    };
    mocks.getPublicationAudience
      .mockResolvedValueOnce(page({ nextCursor: firstCursor }))
      .mockResolvedValueOnce(
        page({
          subscribers: [{ ...contact, email: "second@example.com" }],
          nextCursor: secondCursor,
        }),
      )
      .mockResolvedValueOnce(page({ subscribers: [{ ...contact, email: "third@example.com" }] }));
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByText("second@example.com");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByText("third@example.com");
    expect(mocks.getPublicationAudience).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ cursor: secondCursor }),
    });
  });

  it("shows bulk publication unsubscribe separately from account archive", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.archiveAudienceContacts.mockReturnValueOnce(new Promise(() => {}));
    renderPanel();

    expect(
      screen.queryByRole("toolbar", { name: "Selected audience contacts" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: "Select Reader" }));
    const toolbar = screen.getByRole("toolbar", { name: "Selected audience contacts" });
    expect(within(toolbar).getByText(/archive removes them from every publication/i)).toBeVisible();
    await user.click(within(toolbar).getByRole("button", { name: "Archive account contact" }));
    expect(mocks.archiveAudienceContacts).toHaveBeenCalledWith({
      data: { contactIds: [contact.id] },
    });
    await user.click(
      within(toolbar).getByRole("button", { name: "Unsubscribe newsletter contacts" }),
    );
    expect(mocks.unsubscribePublicationSubscribers).toHaveBeenCalledWith({
      data: {
        publicationId: publication.id,
        subscribers: [{ subscriptionId: contact.subscription_id, email: contact.email }],
      },
    });
  });

  it("keeps read-only subscriber state visible when the workspace is locked", async () => {
    renderPanel(true);

    expect(await screen.findByText("reader@example.com")).toBeVisible();
    expect(screen.getByText(/upgrade to import or manage subscribers/i)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Select Reader" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import subscribers" })).toBeDisabled();
  });
});
