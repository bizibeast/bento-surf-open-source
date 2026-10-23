import { describe, expect, it, vi } from "vitest";
import { AiProviderRequestError } from "./ai-json.server";
import { ProviderBudgetError } from "./provider-budget.server";
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
it("makes X's character budget explicit and gives the editor measured length feedback", async () => {
  expect(editorialSystemPrompt(brief())).toContain("at most 280 X-weighted characters");
  const d = deps();
  const body = "A useful point. ".repeat(25);
  vi.mocked(d.write).mockResolvedValue({ ...good, body });
  const result = await generateEditorialDraft(brief(), { dependencies: d });
  expect(d.edit).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.arrayContaining([
      expect.objectContaining({
        code: "provider_limit",
        message: expect.stringContaining(
          `The body has ${body.trim().length} X-weighted characters`,
        ),
      }),
    ]),
  );
  expect(result.status).toBe("ready");
  expect(result.card).toMatchObject({ body: good.body });
});
function deps(): EditorialGenerationDependencies {
  return {
    write: vi.fn().mockResolvedValue(good),
    edit: vi.fn().mockResolvedValue(good),
    critique: vi.fn().mockResolvedValue(clean),
  };
}
it("passes the failing evidence field to the bounded editor and still independently reviews the repair", async () => {
  const d = deps();
  const corrected = {
    ...good,
    sourceIds: ["s"],
    body: "The notes recommend asking one question at a time. Let the customer finish before moving on.",
    claims: [
      {
        sourceId: "s",
        text: "asking one question at a time",
        quote: "Ask one question at a time.",
      },
    ],
  };
  vi.mocked(d.write).mockResolvedValue({
    ...corrected,
    claims: [{ ...corrected.claims[0], quote: "Ask several questions together." }],
  });
  vi.mocked(d.edit).mockResolvedValue(corrected);
  const result = await generateEditorialDraft(brief(), { dependencies: d });
  expect(d.edit).toHaveBeenCalledTimes(1);
  expect(d.edit).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.any(AbortSignal),
    expect.arrayContaining([
      expect.objectContaining({
        code: "unsupported_claim",
        message: expect.stringMatching(/Claim 1: quote/),
      }),
    ]),
  );
  expect(result.status).toBe("ready");
  expect(result.card).toMatchObject({ body: corrected.body, editorial: { sourceIds: ["s"] } });
  expect(d.critique).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining(corrected),
    expect.any(AbortSignal),
  );
});
describe("verified source attribution", () => {
  const source = {
    id: "report",
    title: "Open formats",
    text: "Acme introduced an open export format for customer records.",
    occurredAt: "2026-10-20T00:00:00Z",
    external: true,
    sourceName: "Example News",
    url: "https://example.com/reports/open-format",
  };
  const reportBrief = () =>
    buildEditorialBrief({
      now: "2026-10-20T12:00:00Z",
      platform: "twitter",
      brain: [],
      sources: [source],
      requiredRecentSourceIds: [source.id],
    });
  const report = {
    ...good,
    body: "Acme now offers an open export format. Check whether your customer data can leave with you before choosing a platform.",
    sourceIds: [source.id],
    sourceUrls: [source.url],
    claims: [
      { sourceId: source.id, text: "Acme now offers an open export format", quote: source.text },
    ],
  };
  it("adds the verified source link before independent review without another paid edit", async () => {
    const d = deps();
    vi.mocked(d.write).mockResolvedValue(report);
    const result = await generateEditorialDraft(reportBrief(), { dependencies: d });
    expect(result.status).toBe("ready");
    expect(result.card).toMatchObject({ body: `${report.body}\n\n${source.url}` });
    expect(d.edit).not.toHaveBeenCalled();
    expect(d.critique).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: `${report.body}\n\n${source.url}`,
      }),
      expect.any(AbortSignal),
    );
  });
  it("still blocks a cited draft rejected by independent review", async () => {
    const d = deps();
    vi.mocked(d.write).mockResolvedValue(report);
    vi.mocked(d.edit).mockResolvedValue(report);
    vi.mocked(d.critique).mockResolvedValue({
      issues: [
        { code: "unsupported_claim", message: "The report does not support that assertion." },
      ],
    });
    const result = await generateEditorialDraft(reportBrief(), { dependencies: d });
    expect(result.status).toBe("needs_input");
    expect(result.card.type).toBe("idea");
    expect(result.issues).toContainEqual({
      code: "unsupported_claim",
      message: "The report does not support that assertion.",
    });
  });
  it("does not append a link when it would exceed the provider limit", async () => {
    const d = deps();
    const long = { ...report, body: `${report.body} ${"x".repeat(157)}` };
    vi.mocked(d.write).mockResolvedValue(long);
    vi.mocked(d.edit).mockResolvedValue(long);
    const result = await generateEditorialDraft(reportBrief(), { dependencies: d });
    expect(result.status).toBe("needs_input");
    expect(d.critique).not.toHaveBeenCalled();
  });
  it("does not repair attribution for unverified evidence", async () => {
    const d = deps();
    const unsupported = {
      ...report,
      claims: [{ ...report.claims[0], quote: "Acme sold all its customer records." }],
    };
    vi.mocked(d.write).mockResolvedValue(unsupported);
    vi.mocked(d.edit).mockResolvedValue(unsupported);
    const result = await generateEditorialDraft(reportBrief(), { dependencies: d });
    expect(result.status).toBe("needs_input");
    expect(result.issues.map((issue) => issue.code)).toContain("unsupported_claim");
    expect(d.critique).not.toHaveBeenCalled();
  });
});

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
  it.each(["repeated_argument", "unsupported_claim"])(
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
  it.each(["reader_value", "voice_drift", "formulaic", "internal_jargon"])(
    "retains a fact-checked draft with %s feedback for human review after revision",
    async (code) => {
      const d = deps();
      const issue = { code, message: "Add a concrete takeaway for the reader." };
      vi.mocked(d.critique).mockResolvedValue({ issues: [issue] });
      const result = await generateEditorialDraft(brief(), { dependencies: d });
      expect(result.status).toBe("ready");
      expect(result.card).toMatchObject({
        type: "draft",
        body: good.body,
        editorial: { validationState: "needs_review", reviewIssues: [issue] },
      });
      expect(result.card).not.toHaveProperty("editorial.reviewSkipped");
      expect(d.write).toHaveBeenCalledTimes(1);
      expect(d.edit).toHaveBeenCalledTimes(1);
      expect(d.critique).toHaveBeenCalledTimes(2);
    },
  );
  it("does not retain a draft when review includes an unsupported factual claim", async () => {
    const d = deps();
    vi.mocked(d.critique).mockResolvedValue({
      issues: [
        { code: "reader_value", message: "Add a takeaway." },
        { code: "unsupported_claim", message: "The source does not support the stated result." },
      ],
    });
    const result = await generateEditorialDraft(brief(), { dependencies: d });
    expect(result.status).toBe("needs_input");
    expect(result.card.type).toBe("idea");
  });
  it("keeps a fact-checked draft and its quality feedback when the revision budget is denied", async () => {
    const d = deps();
    const issue = { code: "reader_value", message: "Add a practical takeaway." };
    vi.mocked(d.critique).mockResolvedValue({ issues: [issue] });
    vi.mocked(d.edit).mockRejectedValue(new ProviderBudgetError("ai_microusd"));
    const result = await generateEditorialDraft(brief(), { dependencies: d });
    expect(result).toMatchObject({
      status: "ready",
      card: {
        type: "draft",
        body: good.body,
        editorial: { validationState: "needs_review", reviewIssues: [issue] },
      },
    });
    expect(d.critique).toHaveBeenCalledTimes(1);
    expect(d.edit).toHaveBeenCalledTimes(1);
  });
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

it("keeps a validated draft when the reviewer never returns", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const d = deps();
    vi.mocked(d.critique).mockImplementation(() => new Promise(() => {}));
    const result = await generateEditorialDraft(brief(), { dependencies: d, timeoutMs: 50 });
    expect(result.status).toBe("ready");
    expect(result.card).toMatchObject({
      type: "draft",
      body: good.body,
      editorial: { validationState: "needs_review", reviewSkipped: true },
    });
    expect(warning).toHaveBeenCalledWith("content_editorial_kept_validated_draft", {
      phase: "timeout",
    });
    expect(d.write).toHaveBeenCalledOnce();
    expect(d.edit).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
it("keeps a validated draft when review fails before the deadline", async () => {
  const d = deps();
  vi.mocked(d.critique).mockRejectedValue(new Error("Provider unavailable"));
  const result = await generateEditorialDraft(brief(), { dependencies: d });
  expect(result.status).toBe("ready");
  expect(result.card).toMatchObject({
    type: "draft",
    body: good.body,
    editorial: { validationState: "needs_review", reviewSkipped: true },
  });
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
    status: "ready",
    card: {
      editorial: {
        validationState: "needs_review",
        reviewIssues: [expect.objectContaining({ code: "voice_drift" })],
      },
    },
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
