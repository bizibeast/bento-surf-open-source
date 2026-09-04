import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => ({ category: undefined, q: "", page: 1 }),
    useLoaderData: () => ({ items: [], page: 1, pageSize: 12, total: 0 }),
  }),
  Link: ({ children }: { children: ReactNode }) => <a href="/explore">{children}</a>,
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/DecodedImage", () => ({ DecodedImage: () => null }));
vi.mock("@/components/MobileTabSelect", () => ({ MobileTabSelect: () => null }));
vi.mock("@/components/PublicAppChrome", () => ({
  PublicAppChrome: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { Route } from "./explore";

describe("Explore declarative WebMCP form", () => {
  it("returns the search destination when an agent autosubmits", async () => {
    const ExplorePage = (Route as unknown as { options: { component: ComponentType } }).options
      .component;
    render(<ExplorePage />);
    const input = screen.getByRole("textbox", { name: "Search creator pages" });
    fireEvent.change(input, { target: { value: "  bizibeast  " } });
    const respondWith = vi.fn();
    const submitEvent = Object.assign(new SubmitEvent("submit", { bubbles: true }), {
      agentInvoked: true,
      respondWith,
    });

    fireEvent(input.closest("form")!, submitEvent);

    expect(respondWith).toHaveBeenCalledOnce();
    const response = respondWith.mock.calls[0][0] as Promise<unknown>;
    await expect(response).resolves.toEqual({
      ok: true,
      message: "Opened matching creator pages in Explore.",
      destination: { path: "/explore", query: "bizibeast", category: null, page: 1 },
    });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/explore",
      search: { category: undefined, q: "bizibeast", page: 1 },
    });
  });
});
