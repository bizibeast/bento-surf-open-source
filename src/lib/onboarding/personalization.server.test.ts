import { describe, expect, it, vi } from "vitest";
import { buildManualCandidates, onboardingBriefSchema, stampOnboardingBrain } from "./brief";
import {
  onboardingBrainSources,
  onboardingSampleIds,
  type OnboardingResearch,
} from "./research.server";
import {
  brainOutputIssues,
  normalizeBrainDocumentKind,
  onboardingBrainSchema,
  personalizeOnboardingBrain,
  prepareOnboardingBrain,
} from "./personalization.server";
import { onboardingProfile } from "./evidence";
import { AiProviderRequestError } from "../ai-json.server";
import { ProviderBudgetError } from "../provider-budget.server";

const brief = onboardingBriefSchema.parse({
  displayName: "Ari",
  expertise: "Lighting for photographers",
  audience: "New photographers",
  bio: "I work as a photographer at Studio North.",
});
const research: OnboardingResearch = {
  profiles: [
    onboardingProfile({
      id: "owned",
      provider: "linkedin",
      provider_display_name: "Ari",
      metadata: {
        headline: "Photographer",
        company: "Studio North",
        access_token: "never-send-this",
      },
    }),
  ],
  posts: [
    {
      id: "post",
      provider: "instagram",
      caption: "I spent three years teaching window lighting at Studio North.",
      remote_post_url: "https://www.instagram.com/p/owned",
    },
  ],
  photoPostId: "post",
};
const base = buildManualCandidates(brief);
const documents = () =>
  base.brain.map((doc) => ({
    ...doc,
    content:
      doc.kind === "profile"
        ? `${doc.content}\n\nI work as a photographer at Studio North. My audience is new photographers learning how to work with natural light.`
        : doc.content,
    claims:
      doc.kind === "profile"
        ? [
            {
              text: "I work as a photographer at Studio North.",
              sourceId: "answers",
              quote: "I work as a photographer at Studio North.",
            },
          ]
        : [],
  }));

describe("bounded personal Brain evidence", () => {
  it("reserves room for answers, profiles and posts without forwarding private metadata", () => {
    const many = {
      ...research,
      profiles: Array.from({ length: 20 }, (_, i) => ({
        ...research.profiles[0],
        connectionId: String(i),
        biography: "界".repeat(3000),
      })),
      posts: Array.from({ length: 24 }, () => ({
        ...research.posts[0],
        caption: "界".repeat(3000),
      })),
    };
    const sources = onboardingBrainSources(brief, many);
    const bytes = (type: string) =>
      sources
        .filter((s) => s.type === type)
        .reduce((n, s) => n + new TextEncoder().encode(s.text).byteLength, 0);
    expect(bytes("answers")).toBeLessThanOrEqual(4000);
    expect(bytes("profile")).toBeLessThanOrEqual(6000);
    expect(bytes("post")).toBeLessThanOrEqual(14000);
    expect(sources.filter((s) => s.type === "post")).toHaveLength(24);
    expect(sources.every((s) => !s.text.includes("�"))).toBe(true);
    expect(JSON.stringify(onboardingBrainSources(brief, research))).not.toContain(
      "never-send-this",
    );
  });
  it("samples recent and strongest posts across platforms within 24 records", () => {
    const rows = ["instagram", "linkedin", "youtube"].flatMap((provider) =>
      Array.from({ length: 40 }, (_, i) => ({ id: `${provider}-${i}`, provider, engagements: i })),
    );
    const ids = onboardingSampleIds(rows);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    for (const provider of ["instagram", "linkedin", "youtube"]) {
      expect(ids).toContain(`${provider}-0`);
      expect(ids).toContain(`${provider}-39`);
    }
  });
  it("rejects fabricated quotes, missing claim text, unsupported stories and incomplete strategies", () => {
    const schema = onboardingBrainSchema(onboardingBrainSources(brief, research));
    expect(schema.safeParse({ documents: documents() }).success).toBe(true);
    for (const change of ["quote", "text"] as const) {
      const docs = documents();
      docs[0].claims[0][change] = "A made-up fact about the creator";
      expect(schema.safeParse({ documents: docs }).success).toBe(false);
    }
    expect(
      schema.safeParse({
        documents: [
          ...documents(),
          { kind: "story", title: "Invented", content: "Invented story. ".repeat(10), claims: [] },
        ],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        documents: documents().map((d) =>
          d.kind === "strategy" ? { ...d, content: "Vague strategy. ".repeat(10) } : d,
        ),
      }).success,
    ).toBe(false);
  });
  it("uses one generation and one independent bounded review before adding source links", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ value: { documents: documents() } })
      .mockImplementation(async ({ input }) => ({
        value: {
          reviews: input.documents.map((doc: { id: string }) => ({
            id: doc.id,
            approved: true,
            sourceIds: ["answers"],
            issues: [],
          })),
        },
      }));
    const result = await personalizeOnboardingBrain(brief, research, Date.now() + 90000, generate);
    expect(generate).toHaveBeenCalledTimes(2);
    // Real post history keeps the full output budget.
    expect(generate.mock.calls[0][0].maxTokens).toBe(6000);
    expect(generate.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(75000);
    expect(JSON.stringify(generate.mock.calls[0][0].input)).not.toContain("https://");
    expect(result[0].content).toContain("Source notes");
  });
});

describe("personalization recovery and caps", () => {
  it("archives stale ready prose and uses creator answers without a paid rerun", async () => {
    const old = {
      ...base,
      brain: base.brain.map((item) =>
        item.kind === "profile"
          ? { ...item, content: "I founded a tool I merely reviewed." }
          : item,
      ),
      personalization: {
        generation: 1,
        status: "ready" as const,
        profileCount: 1,
        postCount: 1,
        note: "Old generated copy",
      },
    };
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const personalize = vi.fn();
    const safe = await prepareOnboardingBrain(
      brief,
      old,
      research,
      1,
      true,
      Date.now() + 90000,
      checkpoint,
      personalize,
    );
    expect(safe.brain).toEqual(base.brain);
    expect(safe.deferredBrain).toEqual(old.brain);
    expect(safe.personalization?.status).toBe("unavailable");
    expect(safe.brainEvidence?.method).toBe("creator_answers");
    expect(personalize).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledOnce();
  });
  it("checkpoints before spending and retains successful or edited Brain on recovery", async () => {
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const personalize = vi.fn().mockImplementation(async () => {
      expect(checkpoint.mock.calls[0][0].personalization.status).toBe("running");
      return base.brain;
    });
    const ready = await prepareOnboardingBrain(
      brief,
      base,
      research,
      1,
      false,
      Date.now() + 90000,
      checkpoint,
      personalize,
    );
    const edited = stampOnboardingBrain(
      {
        ...ready,
        brain: ready.brain.map((d) => ({ ...d, content: `${d.content}\nCreator edit.` })),
      },
      "creator_review",
    );
    expect(
      await prepareOnboardingBrain(
        brief,
        edited,
        research,
        1,
        true,
        Date.now() + 90000,
        checkpoint,
        personalize,
      ),
    ).toEqual(edited);
    expect(
      await prepareOnboardingBrain(
        brief,
        edited,
        research,
        2,
        false,
        Date.now() + 90000,
        checkpoint,
        personalize,
      ),
    ).toEqual(edited);
    expect(personalize).toHaveBeenCalledOnce();
  });
  it("does not repeat a denied, failed or interrupted call during draft recovery", async () => {
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const personalize = vi.fn().mockRejectedValue(new Error("Provider budget denied"));
    const failed = await prepareOnboardingBrain(
      brief,
      base,
      research,
      1,
      false,
      Date.now() + 90000,
      checkpoint,
      personalize,
    );
    expect(failed.personalization?.status).toBe("unavailable");
    expect(failed.brain).toEqual(base.brain);
    await prepareOnboardingBrain(
      brief,
      failed,
      research,
      1,
      true,
      Date.now() + 90000,
      checkpoint,
      personalize,
    );
    await prepareOnboardingBrain(
      brief,
      { ...failed, personalization: { ...failed.personalization!, status: "running" } },
      research,
      1,
      true,
      Date.now() + 90000,
      checkpoint,
      personalize,
    );
    expect(personalize).toHaveBeenCalledOnce();
  });
  it("never calls the provider if the attempt cannot be saved", async () => {
    const personalize = vi.fn();
    await expect(
      prepareOnboardingBrain(
        brief,
        base,
        research,
        1,
        false,
        Date.now() + 90000,
        vi.fn().mockRejectedValue(new Error("Lost lease")),
        personalize,
      ),
    ).rejects.toThrow("Lost lease");
    expect(personalize).not.toHaveBeenCalled();
  });
});

it("does not replace onboarding Brain when a real quote fails the independent ownership review", async () => {
  const docs = documents();
  docs[0].content += "\nI founded Studio North and made $10 million.";
  docs[0].claims.push({
    text: "I founded Studio North and made $10 million.",
    sourceId: "answers",
    quote: "I work as a photographer at Studio North.",
  });
  expect(
    onboardingBrainSchema(onboardingBrainSources(brief, research)).safeParse({ documents: docs })
      .success,
  ).toBe(true);
  const generate = vi
    .fn()
    .mockResolvedValueOnce({ value: { documents: docs } })
    .mockImplementation(async ({ input }) => ({
      value: {
        reviews: input.documents.map((doc: { id: string }, index: number) => ({
          id: doc.id,
          approved: index !== 0,
          sourceIds: ["answers"],
          issues: index === 0 ? ["Employment does not support founding or revenue claims."] : [],
        })),
      },
    }));
  const result = await prepareOnboardingBrain(
    brief,
    base,
    research,
    1,
    false,
    Date.now() + 90000,
    vi.fn(),
    (b, r, deadline) => personalizeOnboardingBrain(b, r, deadline, generate),
  );
  expect(result.brain).toEqual(base.brain);
  expect(result.personalization?.status).toBe("unavailable");
  expect(generate).toHaveBeenCalledTimes(2);
});

it("spends no more than the remaining shared onboarding review window", async () => {
  const start = Date.now();
  const now = vi.spyOn(Date, "now");
  now.mockReturnValue(start);
  const generate = vi
    .fn()
    .mockImplementationOnce(async () => {
      now.mockReturnValue(start + 38000);
      return { value: { documents: documents() } };
    })
    .mockImplementation(async ({ input }) => ({
      value: {
        reviews: input.documents.map((doc: { id: string }) => ({
          id: doc.id,
          approved: true,
          sourceIds: ["answers"],
          issues: [],
        })),
      },
    }));
  try {
    await personalizeOnboardingBrain(brief, research, start + 90000, generate);
    // Writing leaves 5s of the job deadline for the review: 90s - 5s.
    expect(generate.mock.calls[0][0].timeoutMs).toBe(75000);
    // The review gets up to 25s of what is left (capped at 15s per review call).
    expect(generate.mock.calls[1][0].timeoutMs).toBe(15000);
  } finally {
    now.mockRestore();
  }
});

it("gives the Brain up to 110s: 75s to write, then up to 25s of what remains to review", async () => {
  const start = Date.now();
  const now = vi.spyOn(Date, "now");
  now.mockReturnValue(start);
  const generate = vi
    .fn()
    .mockImplementationOnce(async () => {
      now.mockReturnValue(start + 100_000);
      return { value: { documents: documents() } };
    })
    .mockImplementation(async ({ input }) => ({
      value: {
        reviews: input.documents.map((doc: { id: string }) => ({
          id: doc.id,
          approved: true,
          sourceIds: ["answers"],
          issues: [],
        })),
      },
    }));
  try {
    await personalizeOnboardingBrain(brief, research, start + 150_000, generate);
    expect(generate.mock.calls[0][0].timeoutMs).toBe(75000);
    // Step ends at 110s, so only 10s remain for the review.
    expect(generate.mock.calls[1][0].timeoutMs).toBe(10000);
  } finally {
    now.mockRestore();
  }
});

it("asks for three shorter documents when there is no post history", async () => {
  const generate = vi
    .fn()
    .mockResolvedValueOnce({ value: { documents: documents().slice(0, 3) } })
    .mockImplementation(async ({ input }) => ({
      value: {
        reviews: input.documents.map((doc: { id: string }) => ({
          id: doc.id,
          approved: true,
          sourceIds: ["answers"],
          issues: [],
        })),
      },
    }));
  await personalizeOnboardingBrain(
    brief,
    { ...research, posts: [], photoPostId: null },
    Date.now() + 150_000,
    generate,
  );
  expect(generate.mock.calls[0][0].maxTokens).toBe(2500);
  expect(generate.mock.calls[0][0].system).toContain("return exactly 3 documents");
});

describe("Brain failure reporting", () => {
  const run = (error: unknown) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return prepareOnboardingBrain(
      brief,
      base,
      research,
      1,
      false,
      Date.now() + 150_000,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockRejectedValue(error),
    ).then((result) => ({ result, log }));
  };
  it("mentions the allowance only for a real budget error", async () => {
    const { result, log } = await run(new ProviderBudgetError("ai_microusd"));
    expect(result.personalization?.note).toContain("allowance");
    expect(log.mock.calls[0][1]).toEqual(
      expect.objectContaining({ errorClass: "ProviderBudgetError", budget: "ai_microusd" }),
    );
    log.mockRestore();
  });
  it("logs the provider status and elapsed time without the allowance wording", async () => {
    const { result, log } = await run(new AiProviderRequestError(504, "openrouter"));
    expect(result.personalization?.status).toBe("unavailable");
    expect(result.personalization?.note).not.toContain("allowance");
    expect(result.personalization?.note).not.toMatch(/[\u2013\u2014]/);
    expect(log.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        errorClass: "AiProviderRequestError",
        providerStatus: 504,
        provider: "openrouter",
        elapsedMs: expect.any(Number),
        postCount: 1,
      }),
    );
    log.mockRestore();
  });
  it("names timeouts", async () => {
    const { log } = await run(new DOMException("AI generation timed out.", "TimeoutError"));
    expect(log.mock.calls[0][1]).toEqual(expect.objectContaining({ errorClass: "TimeoutError" }));
    log.mockRestore();
  });
});

describe("Brain evidence repair", () => {
  const approve = async ({ input }: { input: { documents: { id: string }[] } }) => ({
    value: {
      reviews: input.documents.map((doc) => ({
        id: doc.id,
        approved: true,
        sourceIds: ["answers"],
        issues: [],
      })),
    },
  });
  const rejected = () => {
    const schema = onboardingBrainSchema(onboardingBrainSources(brief, research));
    const docs = documents();
    docs[0].claims[0].quote = "A made-up fact about the creator";
    const parsed = schema.safeParse({ documents: docs });
    if (parsed.success) throw new Error("expected a rejected Brain");
    return parsed.error;
  };

  it("re-asks once with the failed rule names, then keeps the independent review", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const generate = vi
      .fn()
      .mockRejectedValueOnce(rejected())
      .mockResolvedValueOnce({ value: { documents: documents() } })
      .mockImplementation(approve);
    const result = await personalizeOnboardingBrain(
      brief,
      research,
      Date.now() + 150_000,
      generate,
    );
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[1][0].system).toContain(
      "Use exact document claims and exact quotes from the supplied source.",
    );
    expect(generate.mock.calls[1][0].system).toContain("remove both the fact and its claim");
    expect(generate.mock.calls[1][0].schema).toBe(generate.mock.calls[0][0].schema);
    expect(result[0].content).toContain("Source notes");
    // Diagnostics name rules, never content.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("made-up");
    warn.mockRestore();
  });

  it("does not re-ask a provider error or when the step has no room left", async () => {
    const generate = vi.fn().mockRejectedValue(new AiProviderRequestError(504, "openrouter"));
    await expect(
      personalizeOnboardingBrain(brief, research, Date.now() + 150_000, generate),
    ).rejects.toBeInstanceOf(AiProviderRequestError);
    expect(generate).toHaveBeenCalledTimes(1);

    const late = vi.fn().mockRejectedValue(rejected());
    await expect(
      personalizeOnboardingBrain(brief, research, Date.now() + 30_000, late),
    ).rejects.toBeTruthy();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("stops after one repair when the corrected answer still breaks the rules", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const generate = vi.fn().mockRejectedValue(rejected());
    await expect(
      personalizeOnboardingBrain(brief, research, Date.now() + 150_000, generate),
    ).rejects.toBeTruthy();
    expect(generate).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("reports rule names and schema paths for a rejected Brain", () => {
    expect(brainOutputIssues(rejected())).toEqual([
      "Use exact document claims and exact quotes from the supplied source.",
    ]);
    expect(brainOutputIssues(new Error("other"))).toBeNull();
  });
});

describe("Brain document kinds", () => {
  it("maps display names the prompt uses to kinds and still rejects unknown kinds", () => {
    expect(normalizeBrainDocumentKind("Writing voice")).toBe("instruction");
    expect(normalizeBrainDocumentKind("My Human")).toBe("profile");
    expect(normalizeBrainDocumentKind("Audience & positioning")).toBe("profile");
    expect(normalizeBrainDocumentKind("LinkedIn Strategy")).toBe("strategy");
    expect(normalizeBrainDocumentKind("STORY")).toBe("story");
    expect(normalizeBrainDocumentKind("my_writing_voice")).toBe("instruction");
    expect(normalizeBrainDocumentKind("horoscope")).toBe("horoscope");
    const schema = onboardingBrainSchema(onboardingBrainSources(brief, research));
    const named = documents().map((doc) => ({
      ...doc,
      kind: doc.kind === "instruction" ? "Writing voice" : doc.kind,
    }));
    expect(schema.safeParse({ documents: named }).success).toBe(true);
    const unknown = documents().map((doc) => ({
      ...doc,
      kind: doc.kind === "instruction" ? "horoscope" : doc.kind,
    }));
    const parsed = schema.safeParse({ documents: unknown });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(brainOutputIssues(parsed.error)).toContain(
        "Each document kind must be one of: profile, instruction, strategy, story.",
      );
  });
});
