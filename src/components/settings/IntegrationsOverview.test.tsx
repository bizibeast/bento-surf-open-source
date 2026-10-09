import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationsOverview } from "./IntegrationsOverview";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/lib/integrations.functions", () => ({
  getIntegrationOverview: vi.fn().mockResolvedValue({
    readiness: {
      instagram: true,
      facebook: true,
      threads: true,
      tiktok: true,
      linkedin: true,
      twitter: true,
      youtube: true,
      reddit: false,
    },
    bookingReadiness: { google: true, fathom: true },
    contentReadiness: {
      telegram: true,
      notion: true,
      granola: true,
      github: true,
      slack: true,
    },
    contentProviderMetadata: { telegramUsername: "BentoAgentBot" },
    contentConnections: [],
    socialConnections: [],
    calendarConnections: [],
    fathomConnections: [],
  }),
}));

describe("IntegrationsOverview", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it.each(["social", "bookings", "automation", "knowledge", "channels", "payments"] as const)(
    "scrolls to the %s integration when deep linked",
    async (target) => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <IntegrationsOverview target={target} />
          {target === "payments" && <div id="integration-payments" />}
        </QueryClientProvider>,
      );

      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce());
    },
  );

  it("uses a clean integration directory instead of a category rail", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole("navigation", { name: "Integration categories" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Social" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Meetings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Automations" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent channels" })).toBeInTheDocument();
  });

  it("filters provider tiles without adding category controls", async () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview />
      </QueryClientProvider>,
    );

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview query="YouTube" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Manage YouTube integration/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Manage Threads integration/i }),
    ).not.toBeInTheDocument();
  });

  it("renders social, meeting, and automation tiles without duplicate connect cards", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview target="social" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Google Calendar & Meet")).toBeInTheDocument();
      expect(screen.getAllByText("Fathom recordings")).toHaveLength(2);
      expect(screen.getByText("Instagram DMs")).toBeInTheDocument();
      expect(screen.getByText("Facebook DMs")).toBeInTheDocument();
      expect(screen.getByText("X DMs")).toBeInTheDocument();
    });

    expect(screen.queryByText(/One Instagram login powers/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Manage bookings")).not.toBeInTheDocument();
    expect(document.querySelector('img[src="/brands/fathom.png"]')).toBeInTheDocument();
  });

  it("shows Fathom in both sections and Granola only in Knowledge", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /Manage Fathom recordings integration/i }),
      ).toHaveLength(2);
      expect(screen.getAllByRole("button", { name: /Manage Granola integration/i })).toHaveLength(
        1,
      );
    });
  });

  it("finds Fathom twice and Granola once when searching by provider", async () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview query="Fathom" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Manage Fathom recordings integration/i }),
      ).toHaveLength(2),
    );
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview query="Granola" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Manage Granola integration/i })).toHaveLength(
        1,
      ),
    );
  });

  it("describes each provider as a single workspace account", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsOverview target="social" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Manage Instagram integration/ }),
      ).toHaveAccessibleDescription("One account per Bento profile"),
    );
  });
});
