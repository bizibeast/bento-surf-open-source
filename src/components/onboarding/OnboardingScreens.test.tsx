import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FirstDraft, OnboardingPlanChoices } from "./OnboardingScreens";
import { onboardingBriefSchema } from "@/lib/onboarding/brief";
import type { PaidPlanId, BillingPeriod } from "@/lib/plans";

it("shows all three selectable plans immediately and updates annual pricing", () => {
  function Choices() {
    const [plan, setPlan] = useState<PaidPlanId>("creator_plus");
    const [period, setPeriod] = useState<BillingPeriod>("monthly");
    return (
      <OnboardingPlanChoices plan={plan} period={period} onPlan={setPlan} onPeriod={setPeriod} />
    );
  }
  render(<Choices />);
  expect(screen.getByRole("group", { name: "Billing period" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Monthly" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Store / })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Creator \$/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Creator Plus / })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: /^Store / }));
  expect(screen.getByRole("button", { name: /^Store / })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Yearly 2 months free" }));
  expect(screen.getByRole("button", { name: "Yearly 2 months free" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: /^Store / })).toHaveTextContent("/year");
});

it("shows the owned Instagram photo inside the LinkedIn draft", () => {
  render(
    <FirstDraft
      brief={onboardingBriefSchema.parse({ displayName: "Ari" })}
      draft={{
        title: "One lesson",
        body: "A publishable lesson from my own work.",
        platform: "linkedin",
        format: "post",
        mediaIds: ["11111111-1111-4111-8111-111111111111"],
        mediaPreview: {
          mediaId: "11111111-1111-4111-8111-111111111111",
          url: "https://cdn.bento.surf/owned.jpg",
          alt: "Your photo from the connected Instagram post",
          sourceUrl: "https://www.instagram.com/p/owned",
        },
      }}
    />,
  );
  expect(
    screen.getByRole("img", { name: "Your photo from the connected Instagram post" }),
  ).toHaveAttribute("src", "https://cdn.bento.surf/owned.jpg");
  expect(screen.getByRole("link", { name: /Your photo, from Instagram/ })).toHaveAttribute(
    "href",
    "https://www.instagram.com/p/owned",
  );
  expect(screen.getByText("A publishable lesson from my own work.")).toBeVisible();
});
