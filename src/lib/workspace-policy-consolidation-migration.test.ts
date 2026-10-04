import { describe, expect, it } from "vitest";
import sql from "../../supabase/migrations/20260921022641_workspace_policy_consolidation.sql?raw";

describe("workspace policy consolidation migration", () => {
  it("drops the compatibility policy only when rewritten membership policies exist", () => {
    expect(sql).toContain("from pg_policies replacement");
    expect(sql).toContain("replacement.policyname <> 'workspace_member_access'");
    expect(sql).toContain("private.is_workspace_member");
    expect(sql).toContain("drop policy workspace_member_access");
  });
});
