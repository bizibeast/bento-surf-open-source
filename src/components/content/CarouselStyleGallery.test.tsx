import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CarouselStyleGallery } from "./CarouselStyleGallery";
import { carouselLooks } from "@/lib/content-carousel-looks";
import { DEFAULT_AGENT_BRANDING, agentBrandingSchema } from "@/lib/content-agent-branding";
vi.mock("@/lib/content-studio-carousel", () => ({
  buildStudioCarouselSlide: async () => "<svg/>",
}));
it("selects a readable palette while preserving the creator's portrait and cover settings", () => {
  const brand = {
    ...DEFAULT_AGENT_BRANDING,
    coverStyle: "portrait" as const,
    heroPhotoId: "11111111-1111-4111-8111-111111111111",
  };
  const onChange = vi.fn();
  const { rerender } = render(<CarouselStyleGallery brand={brand} onChange={onChange} />);
  for (const look of carouselLooks)
    expect(agentBrandingSchema.safeParse({ ...brand, ...look }).success).toBe(true);
  expect(screen.getByRole("button", { name: "Use Quiet editorial" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Use Festival pink" }));
  expect(onChange).toHaveBeenCalledWith({
    ...brand,
    accentColor: "#ff2e88",
    backgroundColor: "#16060f",
    textColor: "#fff1f7",
  });
  rerender(
    <CarouselStyleGallery brand={{ ...brand, accentColor: "#123456" }} onChange={onChange} />,
  );
  expect(screen.getByText("Custom colors")).toBeVisible();
});
