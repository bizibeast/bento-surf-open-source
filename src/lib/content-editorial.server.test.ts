import { describe, expect, it, vi } from "vitest";
import { AiProviderRequestError } from "./ai-json.server";
import { contentAgentCardSchema } from "./content-agent";
import { buildEditorialBrief } from "./content-editorial";
import {
  editorialSystemPrompt,
  generateEditorialDraft,
  type EditorialGenerationDependencies,
} from "./content-editorial.server";

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
const clean = { issues: [] };
function deps(): EditorialGenerationDependencies {
  return {
    write: vi.fn().mockResolvedValue(good),
    edit: vi.fn().mockResolvedValue(good),
    critique: vi.fn().mockResolvedValue(clean),
  };
}
describe("bounded editorial generation", () => {
  it("instructs the writer to match sample formatting while forbidding em dashes", () => {
    const prompt = editorialSystemPrompt(brief());
    expect(prompt).toContain("sentence length, line breaks, paragraph spacing");
    expect(prompt).toContain("NEVER use an em dash");
  });
  it("does not release a draft containing an em dash after editing", async () => {
    const d = deps();
    vi.mocked(d.write).mockResolvedValue({
      ...good,
      body: `One question${String.fromCodePoint(0x2014)}one useful answer.`,
    });
    vi.mocked(d.edit).mockResolvedValue({
      ...good,
      body: `One question${String.fromCodePoint(0x2014)}one useful answer.`,
    });
    const result = await generateEditorialDraft(brief(), { dependencies: d });
    expect(result.status).toBe("needs_input");
    expect(result.card.type).toBe("idea");
    expect(d.critique).not.toHaveBeenCalled();
  });
  it("writes and independently critiques a fresh editorial draft before returning reviewable metadata", async () => {
    const d = deps();
    const result = await generateEditorialDraft(brief(), { dependencies: d });
    expect(result.status).toBe("ready");
    expect(result.card).toMatchObject({
      type: "draft",
      editorial: { sourceIds: [], validationState: "passed" },
    });
    expect(d.edit).not.toHaveBeenCalled();
    expect(d.critique).toHaveBeenCalledOnce();
  });
  it.each(["repeated_argument", "voice_drift", "unsupported_claim"])(
    "uses structured critique for %s and falls back after two attempts",
    async (code) => {
      const d = deps();
      const body =
        code === "repeated_argument"
          ? "Base each customer conversation around just one hypothesis."
          : code === "voice_drift"
            ? "Embark on a magnificent customer odyssey of boundless possibility."
            : "The market is worth billions of dollars.";
      vi.mocked(d.edit).mockResolvedValue({ ...good, body });
      vi.mocked(d.critique).mockResolvedValue({
        issues: [{ code, message: "Rewrite the central argument." }],
      });
      const result = await generateEditorialDraft(brief(), { dependencies: d });
      expect(result.status).toBe("needs_input");
      expect(result.card.type).toBe("idea");
      expect(d.write).toHaveBeenCalledTimes(1);
      expect(d.edit).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.any(AbortSignal),
        [{ code, message: "Rewrite the central argument." }],
      );
      expect(d.critique).toHaveBeenCalledWith(
        expect.objectContaining({
          recentOutputs: [
            expect.objectContaining({ body: "Focus each interview on a single assumption." }),
          ],
        }),
        expect.objectContaining({ body }),
        expect.any(AbortSignal),
      );
    },
  );
  it("asks a targeted question without AI when evidence is weak", async () => {
    const d = deps();
    const result = await generateEditorialDraft(
      buildEditorialBrief({ request: "Customer interviews", brain: [], sources: [] }),
      { dependencies: d },
    );
    expect(result.message).toContain("Customer interviews");
    expect(result.message).toContain("?");
    expect(d.write).not.toHaveBeenCalled();
  });
  it("bounds the whole workflow even when an injected provider never settles", async () => {
    const d = deps();
    vi.mocked(d.write).mockImplementation(() => new Promise(() => {}));
    const result = await generateEditorialDraft(brief(), { dependencies: d, timeoutMs: 10 });
    expect(result.status).toBe("retry");
    expect(result.reason).toBe("timeout");
    expect(result.message).not.toContain("what is one specific decision");
    expect(d.write).toHaveBeenCalledOnce();
  });
});

it("edits a legacy seed to a new durable lesson from an old launch and series", async () => {
  const historical = buildEditorialBrief({
    now: "2026-10-12T00:00:00Z",
    platform: "twitter",
    brain: [],
    sources: [
      {
        id: "launch",
        title: "Episode 4: launch",
        text: "In January 2024 I launched a prototype and interviewed customers.",
        occurredAt: "2024-01-10T00:00:00Z",
        external: false,
      },
    ],
  });
  const d = deps();
  vi.mocked(d.edit).mockResolvedValue({
    ...good,
    sourceIds: ["launch"],
    angle: "Use silence to hear a complete customer answer.",
    whyNow: "Apply the old prototype interview lesson to the next customer conversation.",
  });
  const result = await generateEditorialDraft(historical, {
    dependencies: d,
    initialDraft: {
      platform: "twitter",
      format: "post",
      title: "Old series",
      body: "Episode 5: launching today!",
      sourceUrls: [],
      claims: [],
    },
  });
  expect(result.status).toBe("ready");
  expect(d.write).not.toHaveBeenCalled();
  expect(result.card).toMatchObject({
    body: good.body,
    editorial: {
      sourceIds: ["launch"],
      angle: "Use silence to hear a complete customer answer.",
      whyNow: "Apply the old prototype interview lesson to the next customer conversation.",
    },
  });
});
it("production provider calls share the workflow deadline", async () => {
  const ai = { run: vi.fn().mockImplementation(() => new Promise(() => {})) };
  const result = await generateEditorialDraft(brief(), { env: { AI: ai }, timeoutMs: 15 });
  expect(ai.run).toHaveBeenCalledOnce();
  expect(result.status).toBe("retry");
  expect(result.reason).toBe("timeout");
});

it("reports a provider failure as retry even when source evidence is available", async () => {
  const d = deps();
  vi.mocked(d.write).mockRejectedValue(new Error("Provider unavailable"));
  const result = await generateEditorialDraft(brief(), { dependencies: d });
  expect(result).toMatchObject({ status: "retry", reason: "provider" });
  expect(result.message).toContain("try again");
  expect(result.message).not.toContain("what happened");
});
it("keeps source and model critique text out of production diagnostics", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const d = deps();
    vi.mocked(d.critique).mockResolvedValue({
      issues: [{ code: "private-source-text", message: "Private creator anecdote" }],
    });
    await generateEditorialDraft(brief(), { dependencies: d });
    expect(warning).toHaveBeenCalledWith("content_editorial_review", {
      phase: "critique",
      issues: ["other"],
    });
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-source-text|Private creator/);
  } finally {
    warning.mockRestore();
  }
});
it("persists the verified revision identity while retaining edit and voice critique", async () => {
  const target = {
    id: "prior:card",
    messageId: "prior",
    cardId: "card",
    platform: "twitter",
    format: "post",
    body: good.body,
    sourceIds: ["s"],
    sourceUrls: [],
    sources: [],
  };
  const b = { ...brief(), revisionTarget: target };
  const d = deps();
  const result = await generateEditorialDraft(b, { dependencies: d, initialDraft: good });
  expect(result.card).toMatchObject({
    editorial: { revisionOf: { messageId: "prior", cardId: "card" } },
  });
  expect(contentAgentCardSchema.safeParse(result.card).success).toBe(true);
  expect(d.edit).toHaveBeenCalledOnce();
  expect(d.critique).toHaveBeenCalledOnce();
  vi.mocked(d.critique).mockResolvedValue({
    issues: [{ code: "voice_drift", message: "Preserve the creator's plain voice" }],
  });
  expect(await generateEditorialDraft(b, { dependencies: d })).toMatchObject({
    status: "needs_input",
    reason: "quality",
  });
});

it("explains exhausted provider credits without automatically retrying", async () => {
  const d = deps();
  vi.mocked(d.write).mockRejectedValue(new AiProviderRequestError(402, "openrouter"));
  const result = await generateEditorialDraft(brief(), { dependencies: d });
  expect(result.status).toBe("retry");
  expect(result.message).toContain("no available credits");
  expect(result.card).toMatchObject({ type: "idea", takeaway: result.message });
  expect(d.write).toHaveBeenCalledTimes(1);
});
