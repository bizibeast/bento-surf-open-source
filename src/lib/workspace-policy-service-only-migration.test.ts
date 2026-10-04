import { describe, expect, it } from "vitest";
import sql from "../../supabase/migrations/20260921023148_workspace_policy_service_only_cleanup.sql?raw";

describe("workspace service-only policy cleanup", () => {
  it("removes authenticated workspace access from the download audit", () => {
    expect(sql).toContain(
      "drop policy if exists workspace_member_access on public.commerce_download_events",
    );
    expect(sql).not.toContain("grant");
  });
});
