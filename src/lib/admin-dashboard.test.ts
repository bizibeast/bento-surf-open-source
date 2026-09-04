import { describe, expect, it } from "vitest";
import {
  isAdminAccessError,
  sanitizeAdminOperationalMessage,
  summarizeAdminSubscriptions,
  ADMIN_ACCESS_ERROR,
} from "@/lib/admin-dashboard";
import adminRouteSource from "../routes/_authenticated/admin.tsx?raw";

describe("founder dashboard helpers", () => {
  it("reports verified add-on totals without returning customer or object data", async () => {
    const adminFunctions = await import("@/lib/admin.functions");
    const summarize = (
      adminFunctions as typeof adminFunctions & {
        summarizeFounderAddons?: (
          rows: Array<{
            user_id: string;
            plan_id: string;
            contact_tier_contacts: number;
            storage_addon_units: number;
          }>,
          profiles: Array<{ id: string; plan_id: string; is_pro: boolean }>,
          subscribedCounts: Array<{ creator_id: string; subscribed: number }>,
        ) => unknown;
      }
    ).summarizeFounderAddons;

    expect(summarize).toBeTypeOf("function");
    if (!summarize) return;

    const rows = [
      {
        user_id: "creator-500",
        plan_id: "creator",
        contact_tier_contacts: 500,
        storage_addon_units: 2,
        email: "private@example.com",
        object_key: "private/file.mov",
      },
      {
        user_id: "creator-25000-a",
        plan_id: "creator",
        contact_tier_contacts: 25_000,
        storage_addon_units: 3,
      },
      {
        user_id: "creator-25000-b",
        plan_id: "creator",
        contact_tier_contacts: 25_000,
        storage_addon_units: 0,
      },
      {
        user_id: "store-500",
        plan_id: "store",
        contact_tier_contacts: 500,
        storage_addon_units: 4,
      },
    ];

    const summary = summarize(
      rows,
      [
        { id: "creator-500", plan_id: "creator", is_pro: false },
        { id: "creator-25000-a", plan_id: "creator", is_pro: false },
        { id: "creator-25000-b", plan_id: "creator", is_pro: false },
        { id: "store-500", plan_id: "store", is_pro: false },
        { id: "free-contact", plan_id: "free", is_pro: false },
      ],
      [
        { creator_id: "creator-500", subscribed: 501 },
        { creator_id: "creator-25000-a", subscribed: 25_000 },
        { creator_id: "creator-25000-b", subscribed: 25_001 },
        { creator_id: "store-500", subscribed: 500 },
        { creator_id: "free-contact", subscribed: 1 },
      ],
    );

    expect(summary).toEqual({
      contactTiers: [
        { contacts: 500, creators: 1 },
        { contacts: 25_000, creators: 2 },
      ],
      creatorsAboveContactCapacity: 3,
      storageUnits: 9,
    });
    expect(JSON.stringify(summary)).not.toMatch(/creator-|free-contact|private@example|file\.mov/);
    expect(adminRouteSource).toContain("Creators above contact capacity");
  });

  it("chooses the highest active plan across providers", () => {
    const summaries = summarizeAdminSubscriptions([
      {
        user_id: "creator",
        plan_id: "store",
        status: "active",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        user_id: "creator",
        plan_id: "link",
        status: "active",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);

    expect(summaries.get("creator")).toEqual({ planId: "store", status: "active" });
  });

  it("does not treat a newer canceled row as active billing", () => {
    const summaries = summarizeAdminSubscriptions([
      {
        user_id: "creator",
        plan_id: "store",
        status: "canceled",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);

    expect(summaries.get("creator")).toEqual({ planId: null, status: "canceled" });
  });

  it("distinguishes authorization failures from dashboard outages", () => {
    expect(isAdminAccessError(new Error(ADMIN_ACCESS_ERROR))).toBe(true);
    expect(isAdminAccessError(new Error("database unavailable"))).toBe(false);
  });

  it("redacts secrets and personal data in billing failures", () => {
    expect(
      sanitizeAdminOperationalMessage(
        "Bearer abc.def failed for person@example.com using sk_live_supersecret at https://pay.test/x",
      ),
    ).toBe("Bearer [redacted] failed for [email redacted] using [redacted] at [url redacted]");
  });

  it("keeps the founder dashboard controls and KPI dividers aligned on mobile", () => {
    expect(adminRouteSource).toContain('className="col-start-3 grid size-11');
    expect(adminRouteSource).toContain('index % 2 === 1 ? "border-l" : ""');
    expect(adminRouteSource).toContain('index >= 2 ? "border-t" : ""');
    expect(adminRouteSource).toContain('index % 4 === 0 ? "md:border-l-0" : "md:border-l"');
    expect(adminRouteSource).toContain("xl:border-t-0");
  });
});
