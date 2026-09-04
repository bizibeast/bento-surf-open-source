import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727032832_explore_directory_preferences.sql",
);
const permissionsMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727042500_explore_profile_column_permissions.sql",
);
const rankingMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727085917_explore_rank_by_visits.sql",
);
const reviewMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260813181609_explore_review_approval.sql",
);
const adminFunctionsPath = resolve(process.cwd(), "src/lib/admin.functions.ts");
const adminRoutePath = resolve(process.cwd(), "src/routes/_authenticated/admin.tsx");

describe("Explore directory preferences migration", () => {
  it("adds an explicit discovery preference and a validated category", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("show_in_explore boolean not null default true");
    expect(sql).toContain("explore_category text not null default 'creator'");
    expect(sql).toContain("profiles_explore_category_check");
    expect(sql).toContain("'educator'");
  });

  it("indexes only public, completed profiles that opted into Explore", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("where show_in_explore = true");
    expect(sql).toContain("and onboarded = true");
    expect(sql).toContain("and noindex = false");
  });

  it("extends the existing column-level owner permissions to Explore", async () => {
    const sql = (await readFile(permissionsMigrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("grant select (show_in_explore, explore_category)");
    expect(sql).toContain("grant update (show_in_explore, explore_category)");
    expect(sql).toContain("to authenticated");
  });

  it("only lists profiles with blocks and ranks them by lifetime visits", async () => {
    const sql = (await readFile(rankingMigrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("create table if not exists public.profile_visit_totals");
    expect(sql).toContain("create or replace function public.get_explore_profiles");
    expect(sql).toContain("exists (");
    expect(sql).toContain("from public.blocks as block");
    expect(sql).toContain("where block.user_id = profile.id");
    expect(sql).toContain("order by counted.visit_count desc");
  });

  it("keeps the Explore query server-only", async () => {
    const sql = (await readFile(rankingMigrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("security invoker");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  it("requires founder approval before a page can appear on Explore", async () => {
    const sql = (await readFile(reviewMigrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("explore_review_status text not null default 'none'");
    expect(sql).toContain("alter column show_in_explore set default true");
    expect(sql).toContain("and profile.explore_review_status = 'approved'");
    expect(sql).toContain("create trigger profiles_sync_explore_review_on_opt_in");
    expect(sql).toContain("create trigger blocks_sync_explore_review_on_card_change");
    expect(sql).toContain("create or replace function public.compute_explore_review_state");
    expect(sql).toContain("where block.page_id is null");
    expect(sql).toContain("and home_cards.card_count > 3");
    expect(sql).toContain("coalesce(p_card_count, 0) > 3");
    expect(sql).toContain("update of page_id, user_id");
    expect(sql).not.toContain("set show_in_explore = false");
    expect(sql).toContain(
      "when 'pending' then coalesce(counted.explore_opted_in_at, counted.updated_at)",
    );
    expect(sql).toContain(
      "when 'pending' then coalesce(paged.explore_opted_in_at, paged.updated_at)",
    );
    expect(sql).toContain("left join paged on true");
    expect(sql.lastIndexOf("order by")).toBeGreaterThan(sql.lastIndexOf("left join paged on true"));
    expect(sql).toContain("create or replace function public.get_founder_explore_reviews");
    expect(sql).toContain("grant select (explore_review_status)");
    expect(sql).not.toContain("grant update (explore_review_status");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  it("reviews Explore requests only after the founder admin gate", async () => {
    const [serverSource, routeSource] = await Promise.all([
      readFile(adminFunctionsPath, "utf8"),
      readFile(adminRoutePath, "utf8"),
    ]);

    expect(serverSource).toContain("export const getExploreReviews");
    expect(serverSource).toContain("sortExploreReviewsNewestFirst");
    expect(serverSource).toContain("export const reviewExploreProfile");
    expect(serverSource).toContain(
      "That Surf needs more than 3 cards before it can go on Explore.",
    );
    expect(serverSource).toContain('.is("page_id", null)');
    expect(
      serverSource.match(/await assertAdmin\(context\.userId\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(routeSource).toContain(
      'tab: z.enum(["overview", "creators", "operations", "affiliates", "explore"])',
    );
    expect(routeSource).toContain("Explore approvals");
    expect(routeSource).toContain("more than 3 cards");
    expect(routeSource).toContain("data.items.length > 0");
  });
});
