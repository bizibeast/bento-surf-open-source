import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmailMarketingOverview } from "./EmailMarketingOverview";

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "A deliberately long publication name that must remain available to readers",
  status: "published",
};

const contactUsage = {
  limit: 500,
  subscribed: 420,
};

const posts = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "First look at Bento 2.0",
    status: "draft",
    delivery_status: "draft",
    scheduled_at: null,
    updated_at: "2026-09-01T10:00:00.000Z",
    opens: null,
    clicks: null,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Building in public: August recap",
    status: "published",
    delivery_status: "scheduled",
    scheduled_at: "2026-09-03T03:30:00.000Z",
    updated_at: "2026-08-31T10:00:00.000Z",
    opens: 81,
    clicks: 14,
  },
];

describe("EmailMarketingOverview", () => {
  it("continues a draft and distinguishes publication subscribers from account contacts", () => {
    const onSectionChange = vi.fn();
    render(
      <EmailMarketingOverview
        publication={publication}
        creatorName="Ada"
        subscriberCount={42}
        contactUsage={contactUsage}
        posts={posts}
        locked={false}
        onSectionChange={onSectionChange}
      />,
    );

    expect(screen.getByRole("heading", { name: "Welcome back, Ada." })).toBeVisible();
    expect(screen.getByText(publication.title)).toBeVisible();
    const totals = screen.getByRole("region", { name: "Email Marketing totals" });
    expect(totals).toHaveTextContent("42 subscribers in this publication");
    expect(totals).toHaveTextContent("420 / 500 contacts used across all publications");
    fireEvent.click(screen.getByRole("button", { name: "Continue writing" }));
    expect(onSectionChange).toHaveBeenCalledWith("write", posts[0].id);
    expect(document.body).not.toHaveTextContent(/issue/i);
  });

  it("explains account-wide contact usage in place", async () => {
    render(
      <EmailMarketingOverview
        publication={publication}
        creatorName="Ada"
        subscriberCount={42}
        contactUsage={contactUsage}
        posts={posts}
        locked={false}
        onSectionChange={vi.fn()}
      />,
    );

    fireEvent.focus(screen.getByRole("button", { name: "About account-wide contact usage" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "The same contact counts once across all publications",
    );
  });

  it("renders recent Posts as a semantic table and opens the selected row in Write", () => {
    const onSectionChange = vi.fn();
    render(
      <EmailMarketingOverview
        publication={publication}
        creatorName="Ada"
        subscriberCount={42}
        contactUsage={contactUsage}
        posts={posts}
        locked={false}
        onSectionChange={onSectionChange}
      />,
    );

    const table = screen.getByRole("table", { name: "Recent posts" });
    for (const heading of ["Post", "Status", "Schedule", "Updated", "Opens", "Clicks"]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeVisible();
    }
    expect(within(table).getByRole("cell", { name: "First look at Bento 2.0" })).toBeVisible();
    expect(
      within(table).getByRole("cell", { name: "Building in public: August recap" }),
    ).toBeVisible();
    expect(within(table).getByRole("cell", { name: "81" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "14" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open First look at Bento 2.0 in Write" }));
    expect(onSectionChange).toHaveBeenCalledWith("write", posts[0].id);
  });

  it("shows three actionable setup rows for a first-run publication", () => {
    const onSectionChange = vi.fn();
    render(
      <EmailMarketingOverview
        publication={{ ...publication, status: "draft", title: "First Publication" }}
        creatorName="Ada"
        subscriberCount={0}
        contactUsage={{ limit: 500, subscribed: 0 }}
        posts={[]}
        locked={false}
        onSectionChange={onSectionChange}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Finish setting up First Publication" }),
    ).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publication details" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose template" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish website" }));
    expect(onSectionChange.mock.calls).toEqual([["settings"], ["templates"], ["website"]]);
  });

  it("offers a new Post for an empty established publication", () => {
    render(
      <EmailMarketingOverview
        publication={publication}
        creatorName="Ada"
        subscriberCount={0}
        contactUsage={{ limit: 500, subscribed: 0 }}
        posts={[]}
        locked={false}
        onSectionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Write new post" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Recent posts" })).toBeVisible();
    expect(
      screen.getByText("No posts yet. Write your first post when you are ready."),
    ).toBeVisible();
  });

  it("exposes loading, error, and locked states without editable settings", () => {
    const { rerender } = render(
      <EmailMarketingOverview
        publication={null}
        creatorName="Ada"
        subscriberCount={0}
        contactUsage={contactUsage}
        posts={[]}
        locked={false}
        loading
        onSectionChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("status", { name: "Loading publication overview" })).toBeVisible();

    rerender(
      <EmailMarketingOverview
        publication={null}
        creatorName="Ada"
        subscriberCount={0}
        contactUsage={contactUsage}
        posts={[]}
        locked={false}
        error="Could not load this publication."
        onSectionChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this publication.");

    rerender(
      <EmailMarketingOverview
        publication={publication}
        creatorName="Ada"
        subscriberCount={0}
        contactUsage={contactUsage}
        posts={[]}
        locked
        onSectionChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Upgrade to write posts" })).toBeVisible();
    expect(screen.queryByLabelText("Publication name")).toBeNull();

    rerender(
      <EmailMarketingOverview
        publication={null}
        creatorName="Ada"
        subscriberCount={0}
        contactUsage={contactUsage}
        posts={[]}
        locked
        onSectionChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Review plan" })).toBeVisible();
    expect(screen.queryByText(/Use Add publication above/i)).toBeNull();
  });
});
