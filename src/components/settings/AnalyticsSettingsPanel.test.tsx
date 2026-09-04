import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getMyAnalytics } from "@/lib/analytics.functions";
import { AnalyticsSettingsPanel } from "./AnalyticsSettingsPanel";

vi.mock("@/lib/analytics.functions", () => ({
  getMyAnalytics: vi.fn().mockResolvedValue({
    range: "7d",
    timeZone: "Asia/Kolkata",
    timeZoneSource: "saved",
    totalViews: 128,
    uniqueVisitors: 74,
    totalClicks: 39,
    hourly: Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 12 : 0)),
    daily: [
      { date: "2026-07-18", views: 50, clicks: 14 },
      { date: "2026-07-19", views: 78, clicks: 25 },
    ],
    browsers: [{ label: "Chrome", count: 80 }],
    countries: [{ label: "India", count: 91 }],
    cities: [{ label: "Mumbai", count: 48 }],
    sources: [{ label: "Google", count: 42 }],
    mobileDesktop: { mobile: 70, desktop: 52, tablet: 6 },
    social: [
      { label: "Instagram", count: 20 },
      { label: "Twitter", count: 10 },
    ],
    topBlocks: [{ id: "block-1", label: "Book a call", clicks: 16 }],
  }),
}));

describe("AnalyticsSettingsPanel", () => {
  it("renders the complete analytics experience inside settings", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AnalyticsSettingsPanel plan="store" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("128")).toBeInTheDocument();
    expect(vi.mocked(getMyAnalytics)).toHaveBeenCalledWith({
      data: { range: "7d", browserTimeZone: expect.any(String) },
    });
    expect(screen.queryByRole("combobox", { name: "Analytics timezone" })).not.toBeInTheDocument();
    expect(screen.getByText("Activity over time")).toBeInTheDocument();
    expect(screen.getByText("Device type")).toBeInTheDocument();
    expect(screen.getByText("Where visitors come from")).toBeInTheDocument();
    expect(screen.getByText("Social traffic")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Instagram logo" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Twitter logo" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Top-performing blocks")).toBeInTheDocument();
    expect(screen.getByText("🇮🇳")).toBeInTheDocument();
    expect(screen.getByText("Book a call")).toBeInTheDocument();
  });
});
