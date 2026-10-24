import { afterEach, expect, it, vi } from "vitest";
import { AiStructuredOutputError } from "./ai-json.server";
import { buildEditorialBrief } from "./content-editorial";
import {
  generateEditorialDraft,
  isStructuredOutputFailure,
  type EditorialGenerationDependencies,
} from "./content-editorial.server";
import { z } from "zod";

const brief = () =>
  buildEditorialBrief({
    platform: "twitter",
    request: "Customer interviews",
    brain: [],
    sources: [
      {
        id: "s",
        title: "Interview notes",
        text: "Ask one question at a time.",
        occurredAt: "2026-10-12T00:00:00Z",
        external: false,
      },
    ],
    recentOutputs: [{ id: "old", body: "Focus each interview on a single assumption." }],
  });
const good = {
  platform: "twitter",
  format: "post",
  title: "Interviews",
  angle: "Leave silence so customers finish their thoughts.",
  whyNow: "Use pauses in your next interview to hear a complete answer.",
  sourceIds: [],
  body: "Silence gives a customer space to finish their thought. Leave a pause after each answer.",
  sourceUrls: [],
  claims: [],
};
function deps(): EditorialGenerationDependencies {
  return {
    write: vi.fn().mockResolvedValue(good),
    edit: vi.fn().mockResolvedValue(good),
    critique: vi.fn().mockResolvedValue({ issues: [] }),
  };
}
afterEach(() => vi.restoreAllMocks());

it("classifies unparseable and schema-invalid provider output as structured failures", () => {
  expect(isStructuredOutputFailure(new AiStructuredOutputError("length"))).toBe(true);
  expect(isStructuredOutputFailure(z.object({ a: z.string() }).safeParse({}).error)).toBe(true);
  expect(isStructuredOutputFailure(new Error("network"))).toBe(false);
});

it("re-asks once with a format instruction when the writer returns an invalid object", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const d = deps();
  vi.mocked(d.write)
    .mockResolvedValueOnce({ ...good, angle: "short" })
    .mockResolvedValueOnce(good);
  const result = await generateEditorialDraft(brief(), {
    dependencies: d,
    repairStructuredOutput: true,
  });
  expect(result.status).toBe("ready");
  expect(d.write).toHaveBeenCalledTimes(2);
  expect(vi.mocked(d.write).mock.calls[1][1]).toEqual([
    expect.objectContaining({ code: "format" }),
  ]);
  expect(d.edit).not.toHaveBeenCalled();
  // Diagnostics name only the failing schema path, never model output.
  expect(warn).toHaveBeenCalledWith("content_editorial_structured_output", {
    kind: "schema",
    finishReason: null,
    paths: ["angle"],
    repairing: true,
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("Silence gives");
});

it("does not spend a repair call unless the caller opts in", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const d = deps();
  vi.mocked(d.write).mockResolvedValue({ ...good, angle: "short" });
  const result = await generateEditorialDraft(brief(), { dependencies: d });
  expect(result).toMatchObject({ status: "retry", reason: "provider" });
  expect(d.write).toHaveBeenCalledOnce();
});

it("repairs at most once, then reports a retryable provider failure", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const d = deps();
  vi.mocked(d.write).mockRejectedValue(new AiStructuredOutputError("length"));
  const result = await generateEditorialDraft(brief(), {
    dependencies: d,
    repairStructuredOutput: true,
  });
  expect(result).toMatchObject({ status: "retry", reason: "provider" });
  expect(d.write).toHaveBeenCalledTimes(2);
});
