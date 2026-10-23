import { describe, expect, it } from "vitest";
import { enqueueWeeklyDigests } from "./weekly-digest.server";
import {
  compareEmailDeliveryPriority,
  DEFAULT_MARKETING_EMAIL_DAILY_CAP,
  DEFAULT_TRANSACTIONAL_EMAIL_DAILY_CAP,
  emailDailyCap,
  syncEmailDailyCaps,
  weeklyDigestSendCap,
} from "./email-daily-cap";
import {
  selectWeeklyDigests,
  shouldEnqueueWeeklyDigest,
  utcIsoWeekStart,
  weeklyDigestEventKey,
  type WeeklyDigestPage,
} from "./weekly-digest";

const monday = new Date("2026-10-19T09:02:00.000Z");
const weekStart = "2026-10-19";

function page(overrides: Partial<WeeklyDigestPage> = {}): WeeklyDigestPage {
  return {
    authUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "owner@gmail.com",
    recipientName: "Owner",
    workspaceId: "page-home",
    username: "home",
    views: 4,
    clicks: 1,
    sales: 0,
    ...overrides,
  };
}

describe("weekly digest selection", () => {
  it("combines an owner's pages into one email and totals the visits", () => {
    const [draft] = selectWeeklyDigests(
      [
        page({ views: 9, clicks: 3 }),
        page({
          workspaceId: "page-shop",
          username: "shop",
          views: 2,
          clicks: 1,
          sales: 1,
        }),
        page({ workspaceId: "page-quiet", username: "quiet", views: 0, clicks: 8 }),
      ],
      { now: monday, cap: 20 },
    );

    expect(draft).toMatchObject({
      eventKey: weeklyDigestEventKey(page().authUserId, weekStart),
      email: "owner@gmail.com",
      views: 11,
      clicks: 4,
      sales: 1,
      pages: [
        { username: "home", views: 9 },
        { username: "shop", views: 2 },
      ],
    });
    expect(utcIsoWeekStart(monday)).toBe(weekStart);
  });

  it("sends one digest per person when several workspaces share an inbox", () => {
    const drafts = selectWeeklyDigests(
      [
        page({ authUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", views: 3 }),
        page({
          authUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspaceId: "other",
          username: "other",
          views: 2,
        }),
        page({
          authUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          email: "other@gmail.com",
          workspaceId: "solo",
          username: "solo",
          views: 5,
        }),
      ],
      { now: monday, cap: 20 },
    );

    expect(drafts).toHaveLength(2);
    expect(drafts.find((draft) => draft.email === "owner@gmail.com")).toMatchObject({
      authUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      views: 5,
      pages: [
        { username: "home", views: 3 },
        { username: "other", views: 2 },
      ],
    });
  });

  it("skips a user when every page had 0 visits", () => {
    expect(
      selectWeeklyDigests(
        [
          page({ views: 0, clicks: 4, sales: 2 }),
          page({ workspaceId: "other", username: "other", views: 0 }),
        ],
        { now: monday, cap: 20 },
      ),
    ).toEqual([]);
  });

  it("skips disposable domains and plus-address test tags", () => {
    const drafts = selectWeeklyDigests(
      [
        page({ email: "stan@yopmail.com", views: 9 }),
        page({ email: "qa@caps7.com", workspaceId: "caps", username: "caps", views: 4 }),
        page({
          email: "owner+googleoauthreview@gmail.com",
          authUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          workspaceId: "review",
          username: "review",
          views: 6,
        }),
        page({ email: "real+news@gmail.com", views: 1, workspaceId: "real", username: "real" }),
      ],
      { now: monday, cap: 20 },
    );

    expect(drafts.map((draft) => draft.email)).toEqual(["real+news@gmail.com"]);
  });

  it("is idempotent per user per ISO week and does not let retries consume the cap", () => {
    const pages = [
      page({ views: 9 }),
      page({
        authUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        email: "second@gmail.com",
        workspaceId: "second",
        username: "second",
        views: 3,
      }),
    ];
    const first = selectWeeklyDigests(pages, { now: monday, cap: 1 });
    const retry = selectWeeklyDigests(pages, {
      now: monday,
      cap: 1,
      existingEventKeys: first.map((draft) => draft.eventKey),
    });
    const nextWeek = selectWeeklyDigests(pages, {
      now: new Date("2026-10-26T09:00:00.000Z"),
      cap: 1,
      existingEventKeys: first.map((draft) => draft.eventKey),
    });

    expect(first.map((draft) => draft.email)).toEqual(["owner@gmail.com"]);
    expect(retry.map((draft) => draft.email)).toEqual(["second@gmail.com"]);
    expect(first[0]?.eventKey).toBe(`weekly-digest:${page().authUserId}:${weekStart}`);
    expect(nextWeek[0]?.eventKey).toBe(`weekly-digest:${page().authUserId}:2026-10-26`);
    expect(selectWeeklyDigests(pages, { now: monday, cap: 1 }).map((draft) => draft.eventKey)).toEqual(
      first.map((draft) => draft.eventKey),
    );
  });

  it("does not run on other weekdays", () => {
    expect(shouldEnqueueWeeklyDigest(monday)).toBe(true);
    expect(shouldEnqueueWeeklyDigest(new Date("2026-10-20T09:02:00.000Z"))).toBe(false);
  });

  it("does not enqueue a second copy when that ISO week is already stored", async () => {
    const seen = new Set<string>();
    const enqueue = async (inputs: Array<{ eventKey: string }>) => ({
      rows: inputs.flatMap((input) => {
        if (seen.has(input.eventKey)) return [];
        seen.add(input.eventKey);
        return [{ id: input.eventKey }];
      }),
    });
    const existingKeys = async (keys: string[]) => keys.filter((key) => seen.has(key));
    const deps = {
      loadPages: async () => [page()],
      existingKeys,
      enqueue,
      cap: 20,
    };
    await expect(enqueueWeeklyDigests(monday, deps)).resolves.toMatchObject({ enqueued: 1 });
    await expect(enqueueWeeklyDigests(monday, deps)).resolves.toMatchObject({ enqueued: 0 });
    expect(seen.size).toBe(1);
  });
});

describe("email daily caps", () => {
  it("defaults marketing below the shared Resend cap and lets transactional use the full day", () => {
    expect(DEFAULT_MARKETING_EMAIL_DAILY_CAP).toBe(70);
    expect(DEFAULT_TRANSACTIONAL_EMAIL_DAILY_CAP).toBe(100);
    expect(emailDailyCap("marketing", "")).toBe(70);
    expect(emailDailyCap("transactional", "")).toBe(100);
    expect(emailDailyCap("marketing", "40")).toBe(40);
    expect(emailDailyCap("marketing", "nope")).toBe(70);
    expect(weeklyDigestSendCap("", 70)).toBe(20);
    expect(weeklyDigestSendCap("90", 70)).toBe(70);
  });

  it("writes configured caps onto the provider policy", async () => {
    const updates: Array<{ resource: string; dailyLimit: number }> = [];
    await syncEmailDailyCaps({
      from(table) {
        expect(table).toBe("provider_budget_policies");
        return {
          select: () => ({
            in: async () => ({
              data: [
                { resource: "marketing_emails", daily_limit: 10_000 },
                { resource: "transactional_emails", daily_limit: 100 },
              ],
              error: null,
            }),
          }),
          update(values) {
            return {
              eq: async (_column, resource) => {
                updates.push({ resource, dailyLimit: values.daily_limit });
                return { error: null };
              },
            };
          },
        };
      },
    });

    expect(updates).toEqual([{ resource: "marketing_emails", dailyLimit: 70 }]);
  });

  it("sends transactional mail before marketing", () => {
    const rows = [{ category: "marketing" }, { category: "transactional" }, { category: "marketing" }];
    expect([...rows].sort(compareEmailDeliveryPriority).map((row) => row.category)).toEqual([
      "transactional",
      "marketing",
      "marketing",
    ]);
  });
});
