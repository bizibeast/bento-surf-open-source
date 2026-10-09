import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SystemPageItem } from "@/lib/page-system-layout";
import { SystemPageTile } from "./SystemPageTile";

function tile(kind: SystemPageItem["kind"], data: SystemPageItem["data"] = {}): SystemPageItem {
  return {
    key: `${kind}:one`,
    pageId: "11111111-1111-4111-8111-111111111111",
    system: "calendar",
    kind,
    title: "Studio",
    data,
    defaultW: 4,
    defaultH: 2,
  };
}

describe("SystemPageTile", () => {
  it("reads the introduction and Insights period fields supplied by the canvas API", () => {
    const { rerender } = render(
      <SystemPageTile
        item={tile("intro", {
          username: "creator",
          displayName: "Creator",
          description: "A maker's notebook",
        })}
      />,
    );
    expect(screen.getByText("A maker's notebook")).toBeVisible();
    rerender(
      <SystemPageTile
        item={{
          ...tile("summary", { metric: "views", value: 40, displayPeriodDays: 90 }),
          key: "summary:views",
          system: "insights",
        }}
      />,
    );
    expect(screen.getByText("Last 90 days")).toBeVisible();
  });

  it("uses the product tile sizes for booking sessions in the editor and public calendar", () => {
    const session = tile("session", {
      slug: "studio-call",
      durationMinutes: 30,
      priceLabel: "$20",
      subtitle: "A focused call",
      ctaLabel: "Book a call",
    });
    const { rerender } = render(<SystemPageTile item={session} w={2} h={2} />);
    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", "square");
    expect(screen.getByText("Studio")).toBeVisible();
    expect(screen.getByText("$20")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<SystemPageTile item={session} publicUsername="creator" w={4} h={4} />);
    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", "large");
    expect(screen.getByText("30 min · A focused call")).toBeVisible();
    expect(screen.getByText("Book a call")).toBeVisible();
    expect(screen.getByRole("link", { name: /Studio/ })).toHaveAttribute(
      "href",
      "/@creator/products/studio-call",
    );
  });

  it("reuses the review card without exposing source visibility or deletion controls", () => {
    render(
      <SystemPageTile
        item={tile("review", { reviewerName: "Ria", rating: 5, body: "Very useful" })}
      />,
    );
    expect(screen.getByRole("img", { name: "5 out of 5 stars" })).toBeVisible();
    expect(screen.getByText("Very useful")).toBeVisible();
    expect(screen.getByText("Ria")).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("uses the commerce tile design and saved size for Store products", () => {
    const { rerender } = render(
      <SystemPageTile
        item={{
          ...tile("product", {
            kind: "coaching_call",
            public_slug: "studio-call",
            pricing_type: "one_time",
            price_amount: 1900,
            currency: "usd",
            subtitle: "Field guide",
          }),
          system: "store",
        }}
        w={2}
        h={2}
      />,
    );
    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", "square");
    expect(screen.getByText("$19")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    rerender(
      <SystemPageTile
        publicUsername="creator"
        item={{
          ...tile("product", {
            kind: "coaching_call",
            public_slug: "studio-call",
            pricing_type: "one_time",
            price_amount: 1900,
            currency: "usd",
          }),
          system: "store",
        }}
        w={4}
        h={2}
      />,
    );
    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", "wide");
    expect(screen.getByRole("link", { name: /Studio/ })).toHaveAttribute(
      "href",
      "/@creator/products/studio-call",
    );
  });

  it("keeps missing metrics distinct from measured zero", () => {
    const { rerender } = render(
      <SystemPageTile
        item={{ ...tile("summary", { value: null, displayPeriodDays: 30 }), system: "insights" }}
      />,
    );
    expect(screen.getByText("-")).toBeVisible();
    rerender(
      <SystemPageTile
        item={{ ...tile("summary", { value: 0, displayPeriodDays: 30 }), system: "insights" }}
      />,
    );
    expect(screen.getByText("0")).toBeVisible();
  });

  it("shows compact connected-account branding without Reach", () => {
    const { rerender } = render(
      <SystemPageTile
        item={{
          ...tile("account", { provider: "youtube", handle: "studio", followers: 1200 }),
          system: "insights",
        }}
      />,
    );
    expect(screen.getByText(/@studio/)).toBeVisible();
    expect(screen.getByText("1.2K")).toBeVisible();
    const platformMark = screen.getByLabelText("YouTube logo");
    expect(platformMark).toHaveClass("size-4", "rounded-[5px]");
    expect(platformMark.parentElement).toHaveTextContent("@studio");
    expect(screen.getByRole("heading", { name: "Studio" }).previousElementSibling).toBeNull();
    expect(screen.queryByText("YouTube")).toBeNull();
    expect(screen.getByText("Engagement")).toBeVisible();
    expect(screen.queryByText("Reach")).toBeNull();
    rerender(
      <SystemPageTile
        item={{
          ...tile("summary", { metric: "posts", value: 20, displayPeriodDays: 30 }),
          title: "Posts",
          system: "insights",
        }}
      />,
    );
    expect(screen.getByText("Posts").previousElementSibling).toHaveClass("size-7", "rounded-[6px]");
    rerender(
      <SystemPageTile
        item={{
          ...tile("publication", {
            description: "Weekly field notes",
            logoUrl: "javascript:alert(1)",
          }),
          system: "newsletter",
        }}
      />,
    );
    expect(screen.getByText("Weekly field notes")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps visitor conversion actions on published content", () => {
    render(
      <SystemPageTile
        publicUsername="creator"
        item={tile("session", { slug: "studio", ctaLabel: "Book now" })}
      />,
    );
    expect(screen.getByRole("link", { name: "Book now: Studio" })).toHaveAttribute(
      "href",
      "/@creator/products/studio",
    );
  });
});
