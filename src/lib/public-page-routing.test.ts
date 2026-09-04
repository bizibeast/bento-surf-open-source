import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public page route topology", () => {
  it("registers creator subpages as root siblings instead of homepage children", () => {
    const routeTree = readFileSync(resolve(process.cwd(), "src/routeTree.gen.ts"), "utf8");
    const routeDefinition = routeTree.match(
      /const UsernamePageSlugRoute = UsernamePageSlugRouteImport\.update\(\{[\s\S]*?\n\} as any\)/,
    )?.[0];

    expect(routeDefinition).toBeDefined();
    expect(routeDefinition).toContain("path: '/$username/$pageSlug'");
    expect(routeDefinition).toContain("getParentRoute: () => rootRouteImport");
    expect(routeDefinition).not.toContain("getParentRoute: () => UsernameRoute");

    const storeRoute = routeTree.match(
      /const UsernameStoreRoute = UsernameStoreRouteImport\.update\(\{[\s\S]*?\n\} as any\)/,
    )?.[0];
    expect(storeRoute).toBeDefined();
    expect(storeRoute).toContain("path: '/$username/store'");
    expect(storeRoute).toContain("getParentRoute: () => rootRouteImport");
  });
});
