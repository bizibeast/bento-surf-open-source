import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeWeeklyPulse } from "./HomeWeeklyPulse";
import type { HomeWeeklyPulse as WeeklyPulse } from "@/lib/home-weekly-pulse";

const data: WeeklyPulse = {
  startedAt: "2026-11-11T12:00:00Z",
  endedAt: "2026-11-18T12:00:00Z",
  followers: { current: 12, previous: 6 },
  leads: { current: 4, previous: 5 },
  revenue: [{ currency: "usd", current: 5000, previous: 10000 }],
};
describe("Home weekly pulse", () => {
  it("shows followers, leads and paid revenue with their own comparisons", () => {
    render(<HomeWeeklyPulse data={data} />);
    for (const label of ["Followers gained via Auto DM", "Leads generated", "Total revenue"])
      expect(screen.getByRole("heading", { name: label })).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("+100% vs last week")).toBeVisible();
    expect(screen.getByText("-20% vs last week")).toBeVisible();
    expect(screen.getByText("-50% vs last week")).toBeVisible();
    expect(screen.getByText(/USD.*50/)).toBeVisible();
  });
  it("does not turn missing metrics into fabricated zeroes", () => {
    const view = render(<HomeWeeklyPulse data={null} loading />);
    expect(screen.getByRole("region", { name: "Weekly growth" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    view.rerender(<HomeWeeklyPulse data={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("temporarily unavailable");
  });
  it("keeps currencies separate and does not display a fake combined revenue", () => {
    render(
      <HomeWeeklyPulse
        data={{
          ...data,
          revenue: [...data.revenue, { currency: "inr", current: 9000, previous: 8000 }],
        }}
      />,
    );
    expect(screen.getByText(/USD.*50/)).toBeVisible();
    expect(screen.getByText(/INR.*90/)).toBeVisible();
    expect(screen.getByText("Currencies shown separately")).toBeVisible();
    expect(screen.getByText("-50% vs last week")).toBeVisible();
    expect(screen.getByText("+12.5% vs last week")).toBeVisible();
    expect(screen.queryByText(/140/)).not.toBeInTheDocument();
    expect(screen.queryByText(/58,487|Creators like you/)).not.toBeInTheDocument();
  });
});
