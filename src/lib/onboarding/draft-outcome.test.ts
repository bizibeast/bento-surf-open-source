import { expect, it } from "vitest";
import { brainDraftOutcome } from "./draft-outcome";

const candidates = (warning: string | null, warningReason: string | null, drafts = 1) =>
  ({
    brain: [{}, {}, {}],
    drafts: Array.from({ length: drafts }, () => ({})),
    warning,
    warningReason,
  }) as never;

it("reports success only when a running job finishes with a model draft", () => {
  expect(
    brainDraftOutcome(
      "running",
      { jobStatus: "ready", candidates: candidates(null, null), generationCount: 1 },
      "linkedin",
    ),
  ).toEqual({
    event: "brain_draft_succeeded",
    properties: { platform: "linkedin", generation: 1, brain_chapters: 3, drafts: 1 },
  });
});

it("reports the fallback reason when the starter replaced the model draft", () => {
  expect(
    brainDraftOutcome(
      "queued",
      { jobStatus: "ready", candidates: candidates("warn", "provider"), generationCount: 1 },
      "linkedin",
    ),
  ).toMatchObject({
    event: "brain_draft_failed",
    properties: { reason: "provider", job_status: "ready", starter_kept: true },
  });
  expect(
    brainDraftOutcome(
      "running",
      { jobStatus: "failed", candidates: null, generationCount: 2 },
      "twitter",
    ),
  ).toMatchObject({ event: "brain_draft_failed", properties: { reason: "job_failed" } });
});

it("ignores reloads of a finished session", () => {
  expect(
    brainDraftOutcome(
      null,
      { jobStatus: "ready", candidates: candidates(null, null), generationCount: 1 },
      "linkedin",
    ),
  ).toBeNull();
  expect(
    brainDraftOutcome(
      "ready",
      { jobStatus: "ready", candidates: candidates(null, null), generationCount: 1 },
      "linkedin",
    ),
  ).toBeNull();
});
