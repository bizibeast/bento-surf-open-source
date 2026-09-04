import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260730100000_community_member_experience.sql?raw";

describe("community member experience migration", () => {
  it("adds roles, comments, moderation, resources, and notifications", () => {
    expect(migration).toContain("community_role");
    expect(migration).toContain("parent_comment_id");
    expect(migration).toContain("moderation_status");
    expect(migration).toContain("resources jsonb");
    expect(migration).toContain("commerce_community_notifications");
  });

  it("keeps private notifications service-role only", () => {
    expect(migration).toContain(
      "revoke all on public.commerce_community_notifications from anon, authenticated",
    );
    expect(migration).toContain(
      "grant all on public.commerce_community_notifications to service_role",
    );
  });
});
