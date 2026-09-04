import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const functionsSource = resolve(process.cwd(), "src/lib/community.functions.ts");
const pageSource = resolve(process.cwd(), "src/routes/_authenticated/community.tsx");

describe("community deletion", () => {
  it("deletes only the creator's community product through the shared unused-product RPC", async () => {
    const source = await readFile(functionsSource, "utf8");
    expect(source).toContain("export const deleteCreatorCommunity");
    expect(source).toContain("creatorCommunityProduct");
    expect(source).toContain('rpc("delete_unused_commerce_product"');
    expect(source).toContain('.neq("status", "archived")');
  });

  it("exposes a confirmed delete control in community settings", async () => {
    const source = await readFile(pageSource, "utf8");
    expect(source).toContain("deleteCreatorCommunity");
    expect(source).toContain("Delete community");
    expect(source).toContain("Delete permanently");
    expect(source).toContain("Keep community");
  });
});
