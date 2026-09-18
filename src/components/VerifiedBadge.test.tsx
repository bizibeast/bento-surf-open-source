import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerifiedBadge } from "./VerifiedBadge";

describe("VerifiedBadge", () => {
  it("keeps the verification mark blue independently of creator theme tokens", () => {
    render(<VerifiedBadge />);

    expect(screen.getByLabelText("Verified creator")).toHaveStyle({
      color: "rgb(255, 255, 255)",
      fill: "#1d9bf0",
    });
  });
});
