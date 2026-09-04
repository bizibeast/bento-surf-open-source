import { describe, expect, it } from "vitest";
import { clampProductBuilderStep, productBuilderSteps } from "./product-builder-steps";

describe("product builder steps", () => {
  it("keeps the creator focused on one logical group at a time", () => {
    expect(productBuilderSteps(true).map((step) => step.id)).toEqual([
      "basics",
      "pricing",
      "details",
      "page",
    ]);
    expect(productBuilderSteps(false).map((step) => step.id)).toEqual([
      "basics",
      "details",
      "page",
    ]);
  });

  it("keeps navigation inside the available steps", () => {
    expect(clampProductBuilderStep(-1, 4)).toBe(0);
    expect(clampProductBuilderStep(2, 4)).toBe(2);
    expect(clampProductBuilderStep(9, 4)).toBe(3);
  });
});
