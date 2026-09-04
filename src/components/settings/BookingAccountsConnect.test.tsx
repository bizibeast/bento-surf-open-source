import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BookingAccountsConnect } from "./BookingAccountsConnect";

vi.mock("@/lib/booking.functions", () => ({
  beginFathomConnection: vi.fn(),
  beginGoogleCalendarConnection: vi.fn(),
  disconnectBookingConnection: vi.fn(),
  setDefaultBookingConnection: vi.fn(),
}));

describe("BookingAccountsConnect", () => {
  it("keeps multiple calendar accounts inside one provider dialog", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BookingAccountsConnect
          calendarConnections={[
            {
              id: "one",
              email: "one@example.com",
              displayName: "Primary calendar",
              status: "active",
              isDefault: true,
            },
            {
              id: "two",
              email: "two@example.com",
              displayName: "Second calendar",
              status: "active",
              isDefault: false,
            },
          ]}
          fathomConnections={[]}
          googleReady
          fathomReady
          onChanged={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("2 connected")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Manage Google Calendar & Meet integration/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(screen.getByRole("dialog")).not.toHaveClass("overflow-hidden");
    expect(screen.getByText("Primary calendar")).toBeInTheDocument();
    expect(screen.getByText("Second calendar")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect another" })).toBeEnabled();
  });

  it("filters meeting integrations with the shared search query", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BookingAccountsConnect
          calendarConnections={[]}
          fathomConnections={[]}
          googleReady
          fathomReady
          onChanged={vi.fn()}
          query="Fathom"
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Fathom recordings")).toBeInTheDocument();
    expect(screen.queryByText("Google Calendar & Meet")).not.toBeInTheDocument();
  });
});
