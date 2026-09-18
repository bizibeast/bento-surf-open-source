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

  it("renders a session's current details without a redundant editor action", () => {
    render(
      <SystemPageTile
        item={tile("session", {
          durationMinutes: 30,
          priceLabel: "$20",
          subtitle: "A focused call",
        })}
      />,
    );
    expect(screen.getByText("Studio")).toBeVisible();
    expect(screen.getByText(/30 min/)).toBeVisible();
    expect(screen.getByText("$20")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
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

  it("shows store pricing from normalized product data", () => {
    render(
      <SystemPageTile
        item={{
          ...tile("product", {
            kind: "digital_download",
            pricing_type: "one_time",
            price_amount: 1900,
            currency: "usd",
            subtitle: "Field guide",
          }),
          system: "store",
        }}
      />,
    );
    expect(screen.getByText("Field guide")).toBeVisible();
    expect(screen.getByText("$19")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
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
