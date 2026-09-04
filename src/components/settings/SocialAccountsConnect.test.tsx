import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SocialAccountsConnect } from "./SocialAccountsConnect";

vi.mock("@/lib/social-oauth.functions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/social-oauth.functions")>();
  return {
    ...original,
    beginSocialConnection: vi.fn(),
    disconnectSocialConnection: vi.fn(),
  };
});

vi.mock("@/lib/social-connections.functions", () => ({
  beginInstagramConnection: vi.fn(),
  disconnectInstagram: vi.fn(),
}));

describe("SocialAccountsConnect", () => {
  it("offers reconnect when an existing YouTube token predates Analytics access", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SocialAccountsConnect
          connections={[
            {
              id: "youtube",
              provider: "youtube",
              displayName: "Creator channel",
              avatarUrl: "https://cdn.example.com/creator.jpg",
              canPublish: true,
              scopes: [
                "https://www.googleapis.com/auth/youtube.upload",
                "https://www.googleapis.com/auth/youtube.readonly",
              ],
            },
          ]}
          readiness={{ youtube: true }}
          onChanged={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Manage YouTube integration/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(screen.getByRole("dialog")).not.toHaveClass("overflow-hidden");
    expect(screen.getByText("1 of 2 accounts connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(screen.getByText("Reconnect for analytics access")).toBeInTheDocument();
    expect(
      document.querySelector('img[src="https://cdn.example.com/creator.jpg"]'),
    ).toBeInTheDocument();
  });

  it("keeps two connected accounts behind one compact provider tile", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SocialAccountsConnect
          connections={[
            {
              id: "one",
              provider: "threads",
              displayName: "First profile",
              canPublish: true,
              scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights"],
            },
            {
              id: "two",
              provider: "threads",
              displayName: "Second profile",
              canPublish: true,
              scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights"],
            },
          ]}
          readiness={{ threads: true }}
          onChanged={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("2 connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Manage Threads integration/i }));
    expect(screen.getByText("2 of 2 accounts connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 / 2" })).toBeDisabled();
  });
});
