import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { captureProductEvent } from "@/lib/posthog";
import { showcaseItems } from "@/lib/onboarding/showcase";
import { CapabilityShowcase } from "./CapabilityShowcase";

vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
beforeEach(() => vi.mocked(captureProductEvent).mockClear());

it("shows the five capabilities with honest plan labels and trial copy", () => {
  render(<CapabilityShowcase brainChapters={4} onContinue={() => {}} onSkip={() => {}} />);
  for (const title of [
    "Your Brain",
    "Sell products",
    "Schedule and post",
    "Content ideas",
    "AI that creates with you",
  ])
    expect(screen.getByText(title)).toBeVisible();
  expect(screen.getByText(/chapters you just reviewed/)).toBeVisible();
  // Brain and AI are Creator Plus only; never implied for Store or Creator.
  expect(screen.getAllByText("Included with Creator Plus only")).toHaveLength(2);
  expect(screen.getByText("Included with Store, Creator and Creator Plus")).toBeVisible();
  expect(screen.getAllByText("Included with Creator and Creator Plus")).toHaveLength(2);
  expect(screen.getByText(/Your trial includes only the plan you pick/)).toHaveTextContent(
    "Card required.",
  );
  expect(screen.getByText(/No charge if you cancel before the trial ends/)).toBeVisible();
  expect(captureProductEvent).toHaveBeenCalledWith("onboarding_showcase_viewed", {
    items: 5,
    brain_chapters: 4,
  });
});

it("never uses em dashes, numbers or keep-access promises in showcase copy", () => {
  const { container } = render(
    <CapabilityShowcase brainChapters={0} onContinue={() => {}} onSkip={() => {}} />,
  );
  const text = container.textContent || "";
  expect(text).not.toMatch(/\u2014/);
  expect(text).not.toMatch(/keep access/i);
  expect(text).not.toMatch(/all (tools|plans)/i);
  expect(JSON.stringify(showcaseItems(0))).not.toMatch(/\d|\$|%/);
});

it("tracks completion and skip separately", () => {
  const onContinue = vi.fn();
  const onSkip = vi.fn();
  render(<CapabilityShowcase brainChapters={3} onContinue={onContinue} onSkip={onSkip} />);
  fireEvent.click(screen.getByRole("button", { name: /Choose my plan/ }));
  expect(onContinue).toHaveBeenCalledOnce();
  expect(captureProductEvent).toHaveBeenCalledWith(
    "onboarding_showcase_completed",
    expect.objectContaining({ seconds: expect.any(Number) }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(onSkip).toHaveBeenCalledOnce();
  expect(captureProductEvent).toHaveBeenCalledWith(
    "onboarding_showcase_skipped",
    expect.objectContaining({ seconds: expect.any(Number) }),
  );
});
