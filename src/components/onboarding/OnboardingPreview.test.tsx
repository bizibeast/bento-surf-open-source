import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OnboardingPreview } from "./OnboardingPreview";
import { onboardingBriefSchema } from "@/lib/onboarding/brief";

describe("personal onboarding preview", () => {
  it("shows the actual approved identity and links without claiming publication", () => {
    render(
      <OnboardingPreview
        brief={onboardingBriefSchema.parse({
          displayName: "Ari",
          bio: "Photography made simple",
          username: "ari",
          links: [{ title: "My portfolio", url: "https://example.com" }],
        })}
      />,
    );
    expect(screen.getByText("Ari")).toBeInTheDocument();
    expect(screen.getByText("Photography made simple")).toBeInTheDocument();
    expect(screen.getByText("My portfolio")).toBeInTheDocument();
    expect(screen.getByText(/Private preview/)).toBeInTheDocument();
    expect(screen.queryByText(/Published/)).not.toBeInTheDocument();
  });
});
