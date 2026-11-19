import { describe, expect, it } from "vitest";
import { metaDmPreferenceCommand } from "./meta-auto-dm-safety.server";

describe("Meta DM recipient preference commands", () => {
  it("only treats explicit private messages as opt-out commands", () => {
    expect(metaDmPreferenceCommand(" STOP ")).toBe("stop");
    expect(metaDmPreferenceCommand("unsubscribe")).toBe("stop");
    expect(metaDmPreferenceCommand("START")).toBe("start");
    expect(metaDmPreferenceCommand("Please stop by my page")).toBeNull();
  });
});
