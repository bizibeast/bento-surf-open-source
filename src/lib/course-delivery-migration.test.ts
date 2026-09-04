import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260730040000_course_delivery_progress.sql?raw";

describe("course delivery migration", () => {
  it("atomically synchronizes creator-edited lessons into canonical delivery rows", () => {
    expect(migration).toContain("function public.sync_commerce_course_lessons()");
    expect(migration).toContain("after insert or update of kind, settings");
    expect(migration).toContain("on conflict (id) do update");
    expect(migration).toContain("delete from public.commerce_course_lessons");
  });

  it("stores progress per access grant and validates active access in a service-only RPC", () => {
    expect(migration).toContain("create table if not exists public.commerce_course_progress");
    expect(migration).toContain("primary key (access_grant_id, lesson_id)");
    expect(migration).toContain("grant_row.status::text <> 'active'");
    expect(migration).toContain("grant_row.expires_at <= now()");
    expect(migration).toContain(
      "grant execute on function public.set_commerce_course_lesson_progress(uuid, uuid, boolean)",
    );
    expect(migration).toContain("to service_role");
  });

  it("does not expose course progress or its mutation RPC to browser roles", () => {
    expect(migration).toContain(
      "revoke all on public.commerce_course_progress from public, anon, authenticated",
    );
    expect(migration).toContain(
      "from public, anon, authenticated;\ngrant execute on function public.set_commerce_course_lesson_progress",
    );
  });
});
