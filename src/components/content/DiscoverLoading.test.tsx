import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiscoverLoading, DiscoverSkeletonCards } from "./DiscoverLoading";

describe("Discover loading", () => {
  it("announces quality checking while rendering varied noninteractive card placeholders", () => {
    render(<DiscoverLoading status="Checking recent posts…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking recent posts…");
    expect(screen.getByText(/Checking relevance, recency and reported performance/)).toBeVisible();
    expect(document.querySelectorAll(".discover-skeleton-card")).toHaveLength(6);
    expect(document.querySelectorAll('.discover-skeleton-card[data-variant^="text"]')).toHaveLength(
      2,
    );
    expect(document.querySelectorAll(".discover-skeleton-image")).toHaveLength(4);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("can append placeholders within the existing feed without a second live region", () => {
    render(
      <div className="discover-grid">
        <article aria-label="Existing inspiration">Existing inspiration</article>
        <DiscoverSkeletonCards count={3} />
      </div>,
    );
    expect(screen.getByRole("article", { name: "Existing inspiration" })).toBeVisible();
    expect(document.querySelectorAll(".discover-grid > .discover-skeleton-card")).toHaveLength(3);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
