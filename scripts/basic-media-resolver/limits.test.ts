import { describe, it, expect } from "vitest";
import { nextAttempt } from "./limits";
import { execFileSync } from "node:child_process";

describe("private downloader budgets", () => {
  it("counts failed and replayed attempts and rejects the next request at the daily cap", () => {
    let state;
    for (let i = 0; i < 50; i++) state = nextAttempt(state, "2026-11-20T00:00:00Z")!;
    expect(state?.daily).toBe(50);
    expect(nextAttempt(state, "2026-11-20T23:59:00Z")).toBeNull();
    expect(nextAttempt(state, "2026-11-21T00:00:00Z")).toEqual({
      day: "2026-11-21",
      month: "2026-11",
      daily: 1,
      monthly: 51,
    });
  });
  it("preserves monthly usage across days and resets at the UTC month boundary", () => {
    const state = { day: "2026-11-21", month: "2026-11", daily: 0, monthly: 250 };
    expect(nextAttempt(state, "2026-11-22T00:00:00Z")).toBeNull();
    expect(nextAttempt(state, "2026-12-01T00:00:00Z")?.monthly).toBe(1);
  });
  it("runs the real Python source and media isolation policy tests", () => {
    expect(() =>
      execFileSync(
        "python3",
        ["-m", "unittest", "discover", "-s", "scripts/basic-media-resolver", "-p", "test_*.py"],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });
});

it("expires commissioning attempts without resetting monthly accounting", () => {
  const state = { day: "2026-11-21", month: "2026-11", daily: 99, monthly: 200 };
  const last = nextAttempt(state, "2026-11-21T20:00:00Z")!;
  expect(last).toMatchObject({ daily: 100, monthly: 201 });
  expect(nextAttempt(last, "2026-11-21T23:59:00Z")).toBeNull();
  const nextDay = { ...last, day: "2026-11-22", daily: 50 };
  expect(nextAttempt(nextDay, "2026-11-22T20:00:00Z")).toBeNull();
  expect(nextAttempt({ ...state, monthly: 250 }, "2026-11-21T20:00:00Z")).toBeNull();
});

import {
  nextTransfer,
  TRANSFER_BLOCK_BYTES,
  DAILY_TRANSFER_BYTES,
  MONTHLY_TRANSFER_BYTES,
} from "./limits";
it("reserves bounded transfer blocks before egress and enforces daily and monthly ceilings", () => {
  const now = "2026-11-21T00:00:00Z";
  const state = {
    day: "2026-11-21",
    month: "2026-11",
    daily: DAILY_TRANSFER_BYTES - TRANSFER_BLOCK_BYTES,
    monthly: MONTHLY_TRANSFER_BYTES - TRANSFER_BLOCK_BYTES,
  };
  const last = nextTransfer(state, now)!;
  expect(last.daily).toBe(DAILY_TRANSFER_BYTES);
  expect(last.monthly).toBe(MONTHLY_TRANSFER_BYTES);
  expect(nextTransfer(last, now)).toBeNull();
  expect(nextTransfer(last, "2026-11-22T00:00:00Z")).toBeNull();
  expect(nextTransfer(last, "2026-12-01T00:00:00Z")?.monthly).toBe(TRANSFER_BLOCK_BYTES);
});
