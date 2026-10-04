import { describe, expect, it } from "vitest";
import schedulerSource from "./social-scheduler.functions.ts?raw";
import agentActionsSource from "./content-agent.actions.ts?raw";

describe("shared social scheduler domain helper", () => {
  it("keeps validation, ownership, atomic save, and queue gating in one Agent-callable helper", () => {
    expect(schedulerSource).toContain(
      ".handler(({ context, data }) => saveSocialPostForUser(context.userId, data))",
    );
    const helper = schedulerSource.slice(
      schedulerSource.indexOf("export async function saveSocialPostForUser"),
      schedulerSource.indexOf("export const rescheduleSocialPost"),
    );
    expect(helper).toContain("socialPostInputSchema.parse(input)");
    expect(helper).toContain('.eq("user_id", userId)');
    expect(helper).toContain("validatePostForProviders(");
    expect(helper).toContain('db.rpc("save_social_post_atomic"');
    expect(helper).toContain("if (data.publishNow && !data.asDraft)");
    expect(helper).toContain("p_as_draft: Boolean(data.asDraft)");
  });

  it("uses the shared helper for approved Agent scheduling and never requests publish-now", () => {
    expect(agentActionsSource).toContain("saveSocialPostForUser(userId");
    expect(agentActionsSource).toContain("publishNow: false");
    expect(agentActionsSource).toContain("asDraft: false");
  });
});
