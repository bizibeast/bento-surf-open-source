import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearancePanel } from "./AppearancePanel";
import { getMyProfile, updateProfile } from "@/lib/profile.functions";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("@/lib/profile.functions", () => ({
  getMyProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

const profile = {
  id: "creator-1",
  username: "creator",
  theme: "light",
  accent_color: "indigo",
  pattern: "grid",
  pattern_settings: { intensity: 60, opacity: 70 },
  plan_id: "link",
  is_pro: true,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("AppearancePanel pattern controls", () => {
  it("updates intensity and opacity immediately and persists the latest values once", async () => {
    vi.useFakeTimers();
    vi.mocked(getMyProfile).mockResolvedValue(profile as never);
    vi.mocked(updateProfile).mockResolvedValue(profile as never);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["my-profile"], profile);

    render(
      <QueryClientProvider client={queryClient}>
        <AppearancePanel />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Patterns" }));
    fireEvent.change(screen.getByRole("slider", { name: "Intensity" }), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Opacity" }), {
      target: { value: "45" },
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith({
      data: {
        pattern_settings: expect.objectContaining({ intensity: 25, opacity: 45 }),
      },
    });
  });
});
