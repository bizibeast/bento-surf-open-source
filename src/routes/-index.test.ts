import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedGetPublicProfile = vi.hoisted(() => vi.fn());

vi.mock("@/lib/profile.functions", () => ({
  getPublicProfileForRequest: mockedGetPublicProfile,
}));

import { Route } from "./index";

describe("root route boundary", () => {
  beforeEach(() => mockedGetPublicProfile.mockReset());

  it("does not expose corporate marketing routes", () => {
    const marketingRouteFiles = readdirSync(resolve("src/routes")).filter((file) =>
      /^(alternatives|compare|features|tools|use-cases)\./.test(file),
    );

    expect(marketingRouteFiles).toEqual([]);
  });

  it("redirects the application homepage to login", async () => {
    mockedGetPublicProfile.mockResolvedValueOnce(null);
    const loader = Route.options.loader;
    if (typeof loader !== "function") throw new Error("Root route loader is missing.");

    await expect(loader({} as never)).rejects.toMatchObject({
      options: { to: "/login" },
    });
  });

  it("returns a resolved custom-domain profile unchanged", async () => {
    const profile = { profile: { username: "creator" }, customDomain: "creator.example" };
    mockedGetPublicProfile.mockResolvedValueOnce(profile);
    const loader = Route.options.loader;
    if (typeof loader !== "function") throw new Error("Root route loader is missing.");

    await expect(loader({} as never)).resolves.toBe(profile);
  });
});
