import { describe, expect, it } from "vitest";
import { enqueueWeeklyDigests } from "./weekly-digest.server";
import {
  compareEmailDeliveryPriority,
  DEFAULT_MARKETING_EMAIL_DAILY_CEILING,
  weeklyDigestDailyCap,
} from "./email-daily-cap";
import {
  dueWeeklyDigestCohorts,
  selectWeeklyDigests,
  shouldEnqueueWeeklyDigest,
  utcIsoWeekStart,
  weeklyDigestCohort,
  weeklyDigestEventKey,
  weeklyDigestExpired,
  type WeeklyDigestPage,
} from "./weekly-digest";

const monday = new Date("2026-10-19T09:02:00.000Z");
const weekStart = "2026-10-19";
const tuesday = new Date("2026-10-20T09:02:00.000Z");
const wednesday = new Date("2026-10-21T09:02:00.000Z");
/** Known cohorts for fixed ids (see the cohort test). */
const mondayUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const tuesdayUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function uuidFor(index: number) {
  const hex = index.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function manyPages(count: number) {
  return Array.from({ length: count }, (_, index) =>
    page({
      authUserId: uuidFor(index),
      email: `creator${index}@gmail.com`,
      workspaceId: `page-${index}`,
      username: `creator${index}`,
      views: 1 + (index % 7),
    }),
  );
}

/** A fake outbox keyed by event_key, like the unique constraint in production. */
function fakeOutbox() {
  const rows = new Map<string, { createdAt: string }>();
  let clock = monday;
  return {
    rows,
    at(now: Date) {
      clock = now;
    },
    existingKeys: async (keys: string[]) =>
      keys.flatMap((eventKey) => {
        const row = rows.get(eventKey);
        return row ? [{ eventKey, createdAt: row.createdAt }] : [];
      }),
    enqueue: async (inputs: Array<{ eventKey: string }>) => ({
      rows: inputs.flatMap((input) => {
        if (rows.has(input.eventKey)) return [];
        rows.set(input.eventKey, { createdAt: clock.toISOString() });
        return [{ id: input.eventKey }];
      }),
    }),
  };
}

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
    expect(
      selectWeeklyDigests(pages, { now: monday, cap: 1 }).map((draft) => draft.eventKey),
    ).toEqual(first.map((draft) => draft.eventKey));
  });

  it("queues cohort 0 on Monday, adds cohort 1 on Tuesday and keeps rolling over until Sunday", () => {
    expect(dueWeeklyDigestCohorts(monday)).toEqual([0]);
    expect(dueWeeklyDigestCohorts(new Date("2026-10-20T09:02:00.000Z"))).toEqual([0, 1]);
    expect(dueWeeklyDigestCohorts(new Date("2026-10-25T09:02:00.000Z"))).toEqual([0, 1]);
    expect(shouldEnqueueWeeklyDigest(monday)).toBe(true);
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
    const existingKeys = async (keys: string[]) =>
      keys
        .filter((key) => seen.has(key))
        .map((eventKey) => ({ eventKey, createdAt: monday.toISOString() }));
    const deps = {
      loadPages: async () => [page({ authUserId: mondayUser })],
      existingKeys,
      enqueue,
      cap: 20,
    };
    await expect(enqueueWeeklyDigests(monday, deps)).resolves.toMatchObject({ enqueued: 1 });
    await expect(enqueueWeeklyDigests(monday, deps)).resolves.toMatchObject({ enqueued: 0 });
    expect(seen.size).toBe(1);
  });
});

describe("weekly digest cohorts and rollover", () => {
  it("splits people into two stable cohorts by user id", () => {
    expect(weeklyDigestCohort(mondayUser)).toBe(0);
    expect(weeklyDigestCohort(tuesdayUser)).toBe(1);
    expect(weeklyDigestCohort(mondayUser)).toBe(weeklyDigestCohort(mondayUser));
    const counts = [0, 0];
    for (let index = 0; index < 2_000; index += 1) counts[weeklyDigestCohort(uuidFor(index))]! += 1;
    expect(counts[0]).toBeGreaterThan(850);
    expect(counts[1]).toBeGreaterThan(850);
  });

  it("only selects due cohorts", () => {
    const pages = [
      page({ authUserId: mondayUser, email: "mon@gmail.com", workspaceId: "mon", username: "mon" }),
      page({
        authUserId: tuesdayUser,
        email: "tue@gmail.com",
        workspaceId: "tue",
        username: "tue",
      }),
    ];
    expect(
      selectWeeklyDigests(pages, { now: monday, cap: 20, cohorts: [0] }).map(
        (draft) => draft.email,
      ),
    ).toEqual(["mon@gmail.com"]);
    expect(
      selectWeeklyDigests(pages, { now: tuesday, cap: 20, cohorts: [0, 1] }).map(
        (draft) => draft.email,
      ),
    ).toEqual(["mon@gmail.com", "tue@gmail.com"]);
  });

  it("spreads 90 digests over Monday and Tuesday under the daily cap, each person once", async () => {
    const pages = manyPages(90);
    const outbox = fakeOutbox();
    const deps = {
      loadPages: async () => pages,
      existingKeys: outbox.existingKeys,
      enqueue: outbox.enqueue,
      cap: 50,
    };
    const cohortOf = (key: string) => weeklyDigestCohort(key.split(":")[1]!);

    outbox.at(monday);
    const mondayRun = await enqueueWeeklyDigests(monday, deps);
    const mondayKeys = [...outbox.rows.keys()];
    expect(mondayRun.enqueued).toBe(mondayKeys.length);
    expect(mondayKeys.length).toBeLessThanOrEqual(50);
    expect(mondayKeys.every((key) => cohortOf(key) === 0)).toBe(true);

    // A rerun the same day cannot pass the daily cap or resend anyone.
    await expect(enqueueWeeklyDigests(monday, deps)).resolves.toMatchObject({ enqueued: 0 });

    outbox.at(tuesday);
    const tuesdayRun = await enqueueWeeklyDigests(tuesday, deps);
    expect(tuesdayRun.enqueued).toBeLessThanOrEqual(50);
    expect(outbox.rows.size).toBe(90);
    expect(new Set(outbox.rows.keys()).size).toBe(90);
    expect([...outbox.rows.keys()].every((key) => key.endsWith(`:${weekStart}`))).toBe(true);
  });

  it("rolls people held back by the cap over to the next day instead of dropping them", async () => {
    const pages = manyPages(200).filter((entry) => weeklyDigestCohort(entry.authUserId) === 0);
    expect(pages.length).toBeGreaterThan(20);
    const outbox = fakeOutbox();
    const deps = {
      loadPages: async () => pages,
      existingKeys: outbox.existingKeys,
      enqueue: outbox.enqueue,
      cap: 5,
    };
    const days = [monday, tuesday, wednesday, new Date("2026-10-22T09:02:00.000Z")];
    for (const day of days) {
      outbox.at(day);
      const run = await enqueueWeeklyDigests(day, deps);
      expect(run.enqueued).toBeLessThanOrEqual(5);
    }
    expect(outbox.rows.size).toBe(20);
    // The highest-traffic Monday people go first.
    const firstDay = [...outbox.rows.entries()]
      .filter(([, row]) => row.createdAt === monday.toISOString())
      .map(([key]) => key);
    expect(firstDay).toHaveLength(5);
  });

  it("starts a fresh week on the next Monday and never sends an old week's digest late", async () => {
    const outbox = fakeOutbox();
    const deps = {
      loadPages: async () => [page({ authUserId: mondayUser })],
      existingKeys: outbox.existingKeys,
      enqueue: outbox.enqueue,
      cap: 40,
    };
    await enqueueWeeklyDigests(monday, deps);
    const nextMonday = new Date("2026-10-26T09:02:00.000Z");
    outbox.at(nextMonday);
    await enqueueWeeklyDigests(nextMonday, deps);
    expect([...outbox.rows.keys()]).toEqual([
      weeklyDigestEventKey(mondayUser, "2026-10-19"),
      weeklyDigestEventKey(mondayUser, "2026-10-26"),
    ]);
    expect(weeklyDigestExpired(weeklyDigestEventKey(mondayUser, "2026-10-19"), nextMonday)).toBe(
      true,
    );
    expect(
      weeklyDigestExpired(
        weeklyDigestEventKey(mondayUser, "2026-10-19"),
        new Date("2026-10-25T23:59:00.000Z"),
      ),
    ).toBe(false);
    expect(weeklyDigestExpired("onboarding-quick-win:user", nextMonday)).toBe(false);
  });
});

describe("email daily caps", () => {
  it("keeps the digest's daily share under the marketing ceiling", () => {
    expect(DEFAULT_MARKETING_EMAIL_DAILY_CEILING).toBe(60);
    expect(weeklyDigestDailyCap("")).toBe(45);
    expect(weeklyDigestDailyCap("25")).toBe(25);
    expect(weeklyDigestDailyCap("nope")).toBe(45);
    expect(weeklyDigestDailyCap("90")).toBe(60);
  });

  it("sends transactional mail before marketing", () => {
    const rows = [
      { category: "marketing" },
      { category: "transactional" },
      { category: "marketing" },
    ];
    expect([...rows].sort(compareEmailDeliveryPriority).map((row) => row.category)).toEqual([
      "transactional",
      "marketing",
      "marketing",
    ]);
  });
});
