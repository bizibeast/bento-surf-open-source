import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; workspaceId: string; start: number }>,
  fail: false,
}));
vi.mock("./session.server", () => ({
  onboardingDb: {
    from: (table: string) => {
      let workspaceId = "";
      const query = {
        select: () => query,
        eq: (_: string, value: string) => {
          workspaceId = value;
          return query;
        },
        order: () => query,
        range: async (start: number) => {
          state.calls.push({ table, workspaceId, start });
          return {
            error: state.fail ? { message: "private database detail" } : null,
            data:
              table === "creator_brain_items"
                ? Array.from({ length: start === 0 ? 500 : 1 }, (_, i) => ({
                    id: `${start + i}`,
                    content: "My saved work",
                  }))
                : [],
          };
        },
      };
      return query;
    },
  },
}));
import { readOnboardingExport } from "./export.server";
beforeEach(() => {
  state.calls = [];
  state.fail = false;
});
describe("read-only content recovery", () => {
  it("exports all pages of the selected workspace without asking for a paid plan", async () => {
    const result = await readOnboardingExport("selected-workspace");
    expect(result.brain).toHaveLength(501);
    expect(state.calls.every((call) => call.workspaceId === "selected-workspace")).toBe(true);
    expect(state.calls).toContainEqual({
      table: "creator_brain_items",
      workspaceId: "selected-workspace",
      start: 500,
    });
  });
  it("fails without returning a silently incomplete export", async () => {
    state.fail = true;
    await expect(readOnboardingExport("selected-workspace")).rejects.toThrow(
      "Your export could not be prepared",
    );
  });
});
