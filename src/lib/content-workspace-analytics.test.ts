import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("./posthog.server", () => ({ captureServerEvent: mocks.capture }));

import { recordContentEvent } from "./content-workspace-analytics.server";

beforeEach(() => vi.clearAllMocks());

it("records lifecycle metadata without creator content", async () => {
  await recordContentEvent("creator", "content_draft_approved", {
    platform: "linkedin",
    format: "post",
    sourceCount: 2,
    body: "private draft",
    brainItems: ["private story"],
    access_token: "secret",
  });
  expect(mocks.capture).toHaveBeenCalledWith(
    "creator",
    "content_draft_approved",
    { platform: "linkedin", format: "post", source_count: 2 },
    expect.anything(),
  );
  expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private draft");
  expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private story");
  expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("secret");
});

it("bounds routine and feedback metadata to event-specific allowlists", async () => {
  await recordContentEvent("creator", "content_routine_run", {
    template: "fill_schedule",
    status: "succeeded",
    resultCount: 5,
    error: "private provider response",
  });
  expect(mocks.capture).toHaveBeenCalledWith(
    "creator",
    "content_routine_run",
    { template: "fill_schedule", status: "succeeded", result_count: 5 },
    expect.anything(),
  );
});
