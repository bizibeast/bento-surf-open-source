import { expect, it, vi } from "vitest";
const capture = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./posthog.server", () => ({ captureServerEvent: capture }));
import { recordContentEvent } from "./content-workspace-analytics.server";
it("allows edited status while dropping all private copy and metadata", async () => {
  await recordContentEvent("owner", "content_agent_draft_review", {
    status: "edited",
    count: 1,
    body: "private",
    slides: ["private"],
    feedback: "private",
    sourceUrls: ["https://private.test"],
    error: "private",
  });
  expect(capture).toHaveBeenLastCalledWith(
    "owner",
    "content_agent_draft_review",
    { status: "edited", count: 1 },
    expect.anything(),
  );
});
it("records only controlled states and finite counts for rollout events", async () => {
  await recordContentEvent("owner", "content_agent_delivery", {
    status: "delivered",
    count: 1,
    prompt: "secret",
    source: "secret",
  });
  expect(capture).toHaveBeenLastCalledWith(
    "owner",
    "content_agent_delivery",
    { status: "delivered", count: 1 },
    expect.anything(),
  );
  for (const event of [
    "content_agent_delivery",
    "content_agent_dismissal",
    "content_agent_image",
    "content_agent_draft_review",
    "content_agent_novelty_rejection",
  ] as const) {
    await recordContentEvent("owner", event, {
      status: "private model critique",
      action: "https://private/photo",
      issue: "private rationale",
      count: Infinity,
    });
    const properties = capture.mock.lastCall![2];
    expect(JSON.stringify(properties)).not.toMatch(/private|https|Infinity/);
  }
  await recordContentEvent("owner", "content_agent_image_quota", {
    successful: 99,
    pending: 1,
    prompt: "secret",
    limit: 100,
    referenceIds: ["secret"],
  });
  expect(capture.mock.lastCall![2]).toEqual({ successful: 99, pending: 1 });
  await recordContentEvent("owner", "content_agent_image_quota", {
    successful: "private",
    pending: NaN,
  });
  expect(capture.mock.lastCall![2]).toEqual({ successful: 0, pending: 0 });
});
