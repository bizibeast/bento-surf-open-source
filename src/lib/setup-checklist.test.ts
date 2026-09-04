import { describe, expect, it } from "vitest";
import { getSetupChecklistSteps, setupChecklistProgress } from "./setup-checklist";

describe("setup checklist", () => {
  it("starts with every milestone incomplete", () => {
    const steps = getSetupChecklistSteps(
      {
        display_name: "",
        bio: "",
        theme: "system",
        accent_color: "sky",
        header_mode: "with_photo",
        pattern: "none",
      },
      [],
      false,
    );

    expect(steps.map((step) => step.complete)).toEqual([false, false, false, false, false, false]);
    expect(setupChecklistProgress(steps)).toEqual({ completed: 0, total: 6, percentage: 0 });
  });

  it("derives completion from real profile and block state", () => {
    const steps = getSetupChecklistSteps(
      {
        display_name: "Maya",
        bio: "Illustrator and teacher",
        avatar_url: "https://cdn.example.com/maya.jpg",
        theme: "dark",
        accent_color: "sky",
        header_mode: "with_photo",
        pattern: "none",
      },
      [{ type: "social_link" }, { type: "commerce" }],
      true,
    );

    expect(steps.every((step) => step.complete)).toBe(true);
    expect(setupChecklistProgress(steps)).toEqual({ completed: 6, total: 6, percentage: 100 });
  });

  it("does not count a social as featured content", () => {
    const steps = getSetupChecklistSteps(null, [{ type: "social_link" }], false);

    expect(steps.find((step) => step.id === "social")?.complete).toBe(true);
    expect(steps.find((step) => step.id === "content")?.complete).toBe(false);
  });

  it("counts a social independently of which creator page contains it", () => {
    const accountBlocks = [{ type: "heading" }, { type: "social_link" }];
    const steps = getSetupChecklistSteps(null, accountBlocks, false);

    expect(steps.find((step) => step.id === "social")?.complete).toBe(true);
    expect(steps.find((step) => step.id === "content")?.complete).toBe(true);
  });
});
