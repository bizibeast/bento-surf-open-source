import { describe, expect, it } from "vitest";
import {
  proactiveWorkspaceIds,
  proactiveDeliveryAvailable,
  imageProviderAvailable,
} from "./content-agent-config.server";
describe("server rollout controls", () => {
  const id = "80000000-0000-4000-8000-000000000001";
  it("defaults closed and supports an explicit cohort or a server-owned general release", () => {
    expect(proactiveDeliveryAvailable(id, {})).toBe(false);
    expect(
      proactiveWorkspaceIds({
        CONTENT_AGENT_PROACTIVE_ENABLED: "true",
        CONTENT_AGENT_PROACTIVE_WORKSPACES: "secret source",
      }),
    ).toEqual([]);
    expect(
      proactiveDeliveryAvailable(id, {
        CONTENT_AGENT_PROACTIVE_ENABLED: "true",
        CONTENT_AGENT_PROACTIVE_WORKSPACES: id,
      }),
    ).toBe(true);
  });
  it("opens general availability only with both server switches, while image consent remains independent", () => {
    const config = {
      CONTENT_AGENT_PROACTIVE_ENABLED: "true",
      CONTENT_AGENT_PROACTIVE_WORKSPACES: "*",
    };
    expect(proactiveWorkspaceIds(config)).toBeNull();
    expect(proactiveDeliveryAvailable(id, config)).toBe(true);
    expect(proactiveDeliveryAvailable("invalid", config)).toBe(false);
    expect(
      proactiveDeliveryAvailable(id, { ...config, CONTENT_AGENT_PROACTIVE_ENABLED: "false" }),
    ).toBe(false);
    expect(imageProviderAvailable(id, config)).toBe(false);
  });
  it("keeps image and proactive rollout independent, with a provider key required", () => {
    const config = {
      CONTENT_AGENT_IMAGES_ENABLED: "true",
      CONTENT_AGENT_IMAGES_WORKSPACES: id,
      APIMART_API_KEY: "test",
    };
    expect(imageProviderAvailable(id, config)).toBe(true);
    expect(proactiveDeliveryAvailable(id, config)).toBe(false);
    expect(imageProviderAvailable(id, { ...config, APIMART_API_KEY: "" })).toBe(false);
    expect(imageProviderAvailable("other", config)).toBe(false);
  });
});
