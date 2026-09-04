import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260823143000_canonical_creator_urls.sql?raw";
import profileRoute from "../routes/$username.tsx?raw";
import pageRoute from "../routes/$username_.$pageSlug.tsx?raw";
import calendarRoute from "../routes/$username_.calendar.tsx?raw";
import productRoute from "../routes/$username_.products.$productSlug.tsx?raw";
import productSuccessRoute from "../routes/$username_.products.$productSlug_.success.tsx?raw";
import { RESERVED_CREATOR_PAGE_SLUGS, uniquePageSlug } from "./pages.functions";
import { resolvePublicUsername } from "./username-alias.server";

describe("canonical creator URL contract", () => {
  it("preserves username history and adds creator-scoped product slugs", () => {
    expect(migration).toContain("profile_username_aliases");
    expect(migration).toContain("preserve_profile_username_alias");
    expect(migration).toContain("public_slug");
    expect(migration).toContain("commerce_products_creator_public_slug_idx");
    expect(migration).toContain("'/products/' || new.public_slug");
    expect(migration).toContain("interval '14 days'");
    expect(migration).toContain("username_changed_at");
    expect(migration).toContain("interval '30 days'");
    expect(migration).toContain("before insert or update on public.profiles");
    expect(migration).toContain("new.username_changed_at = old.username_changed_at");
  });

  it("uses temporary redirects for expiring username aliases", () => {
    for (const route of [
      profileRoute,
      pageRoute,
      calendarRoute,
      productRoute,
      productSuccessRoute,
    ]) {
      expect(route).toContain("statusCode: 307");
      expect(route).not.toContain("statusCode: 308");
    }
  });

  it("routes future custom pages away from system resource names", async () => {
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      eq: () => query,
      neq: () => query,
      maybeSingle: async () => ({ data: null }),
    });
    const supabase = { from: () => query };

    expect(RESERVED_CREATOR_PAGE_SLUGS).toEqual(
      new Set(["calendar", "insights", "newsletter", "products"]),
    );
    expect(await uniquePageSlug(supabase as never, "creator-id", "products")).toBe("products-page");
  });

  it("resolves historical usernames to the account's current username", async () => {
    const tables: Record<string, Array<Record<string, string>>> = {
      profiles: [{ id: "creator-id", username: "newname" }],
      profile_username_aliases: [
        {
          user_id: "creator-id",
          username: "oldname",
          expires_at: "2999-01-01T00:00:00.000Z",
        },
        {
          user_id: "creator-id",
          username: "expiredname",
          expires_at: "2000-01-01T00:00:00.000Z",
        },
      ],
    };
    const db = {
      from(table: keyof typeof tables) {
        const filters: Record<string, unknown> = {};
        const query = {
          select: () => query,
          eq(key: string, value: unknown) {
            filters[key] = value;
            return query;
          },
          gt(key: string, value: unknown) {
            filters[key] = { gt: value };
            return query;
          },
          async maybeSingle() {
            const data = tables[table].find((row) =>
              Object.entries(filters).every(([key, value]) =>
                typeof value === "object" && value && "gt" in value
                  ? row[key] > String(value.gt)
                  : row[key] === value,
              ),
            );
            return { data: data ?? null, error: null };
          },
        };
        return query;
      },
    };

    await expect(resolvePublicUsername(db, "@newname")).resolves.toEqual({
      userId: "creator-id",
      username: "newname",
      isAlias: false,
    });
    await expect(resolvePublicUsername(db, "OLDNAME")).resolves.toEqual({
      userId: "creator-id",
      username: "newname",
      isAlias: true,
    });
    await expect(resolvePublicUsername(db, "expiredname")).resolves.toBeNull();
  });
});
