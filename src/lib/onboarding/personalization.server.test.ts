import { describe, expect, it, vi } from "vitest";
import { buildManualCandidates, onboardingBriefSchema, stampOnboardingBrain } from "./brief";
import {
  onboardingBrainSources,
  onboardingSampleIds,
  type OnboardingResearch,
} from "./research.server";
import {
  brainOutputIssues,
  groundBrainDocuments,
  normalizeBrainDocumentKind,
  onboardingBrainSchema,
  personalizeOnboardingBrain,
  prepareOnboardingBrain,
} from "./personalization.server";
import { onboardingProfile } from "./evidence";
import { AiProviderRequestError, AiStructuredOutputError } from "../ai-json.server";
import {
  buildEvidenceSnippets,
  evidenceSupport,
  groundClaim,
  stripEvidenceIds,
} from "./brain-evidence";
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
  it("uses one generation and one independent bounded review before adding source links", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ value: { documents: documents() } })
      .mockImplementation(async ({ input }) => ({
        value: {
          reviews: (input.chapters ?? input.documents).map((doc: { id: string }) => ({
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
    expect(result.brain[0].content).toContain("Source notes");
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
        reviews: (input.chapters ?? input.documents).map((doc: { id: string }) => ({
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
    // The review gets up to 25s of what is left (capped at 20s per review call).
    expect(generate.mock.calls[1][0].timeoutMs).toBe(20000);
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
        reviews: (input.chapters ?? input.documents).map((doc: { id: string }) => ({
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
        reviews: (input.chapters ?? input.documents).map((doc: { id: string }) => ({
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
  expect(generate.mock.calls[0][0].maxTokens).toBe(3000);
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

describe("evidence-grounded personal Brain", () => {
  const review =
    (unsupported: Record<string, string[]> = {}) =>
    async ({ input }: { input: { chapters: { id: string }[] } }) => ({
      value: {
        reviews: input.chapters.map((chapter) => ({
          id: chapter.id,
          unsupported: unsupported[chapter.id] ?? [],
        })),
      },
    });
  const sources = onboardingBrainSources(brief, research);
  const snippets = buildEvidenceSnippets(sources);
  const snippetFor = (text: string) => snippets.find((snippet) => snippet.text.includes(text))!.id;

  it("numbers verbatim snippets from answers, profiles and posts", () => {
    for (const snippet of snippets) {
      const source = sources.find((item) => item.id === snippet.sourceId)!;
      expect(source.text).toContain(snippet.text);
    }
    expect(new Set(snippets.map((snippet) => snippet.sourceId))).toEqual(
      new Set(sources.map((source) => source.id)),
    );
  });

  it("accepts paraphrases backed by cited snippets and inserts the snippet verbatim", () => {
    const grounded = groundClaim(
      {
        text: "Ari spent three years teaching window lighting at Studio North.",
        evidence: [snippetFor("three years")],
      },
      snippets,
    );
    expect(grounded?.[0].quote).toBe(
      "I spent three years teaching window lighting at Studio North.",
    );
    // A wrong id still finds the supporting snippet.
    expect(
      groundClaim(
        { text: "Works as a photographer at Studio North.", evidence: ["e999"] },
        snippets,
      ),
    ).not.toBeNull();
    // Smart quotes, case and punctuation do not matter for a free quote.
    expect(
      groundClaim(
        {
          text: "I work as a photographer at Studio North",
          quote: "i WORK as a photographer at studio north",
        },
        snippets,
      ),
    ).not.toBeNull();
  });

  it("rejects claims with invented names or numbers even when most words match", () => {
    expect(
      groundClaim(
        { text: "I spent ten years teaching window lighting at Studio North." },
        snippets,
      ),
    ).not.toBeNull(); // "ten" is a word, but no digit to check; content words still match
    expect(
      groundClaim(
        { text: "I spent 7 years teaching window lighting at Studio North.", evidence: ["e1"] },
        snippets,
      ),
    ).toBeNull();
    expect(
      groundClaim({ text: "I teach window lighting at Harvard University." }, snippets),
    ).toBeNull();
    expect(evidenceSupport("I founded a unicorn startup", "I work as a photographer")).toBe(0);
  });

  it("drops only the unsupported claim and its sentence, keeping the chapter", () => {
    const docs = documents();
    docs[0].content += "\n\nI was a gold medalist at the Paris Olympics.";
    docs[0].claims.push({
      text: "I was a gold medalist at the Paris Olympics.",
      sourceId: "answers",
      quote: "gold medal",
    });
    const result = groundBrainDocuments(docs, snippets);
    expect(result.droppedClaims).toBe(1);
    expect(result.documents).toHaveLength(3);
    expect(result.documents[0].content).not.toContain("Olympics");
    expect(result.documents[0].content).toContain("Studio North");
  });

  it("removes sentences the reviewer flags instead of failing the Brain", async () => {
    const docs = documents();
    docs[0].content += "\n\nI have coached 500 photographers.";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ value: { documents: docs } })
      .mockImplementation(review({ "chapter-1": ["I have coached 500 photographers."] }));
    const result = await personalizeOnboardingBrain(
      brief,
      research,
      Date.now() + 150_000,
      generate,
    );
    expect(result.personalChapters).toBe(3);
    expect(result.brain[0].content).not.toContain("500");
    expect(result.brain[0].content).toContain("Source notes");
    expect(generate.mock.calls[1][0].input.sources.map((s: { id: string }) => s.id)).toEqual(
      sources.map((source) => source.id),
    );
    info.mockRestore();
  });

  it("keeps the Brain when the reviewer is unavailable, without unsourced numbers", async () => {
    const docs = documents();
    docs[0].content += "\n\nI have coached 500 photographers.";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ value: { documents: docs } })
      .mockRejectedValue(new AiProviderRequestError(504, "openrouter"));
    const result = await personalizeOnboardingBrain(
      brief,
      research,
      Date.now() + 150_000,
      generate,
    );
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.personalChapters).toBe(3);
    expect(result.brain[0].content).not.toContain("500");
    warn.mockRestore();
    info.mockRestore();
  });

  it("fills a missing or incomplete chapter with the answer-based version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const docs = documents().map((doc) =>
      doc.kind === "strategy" ? { ...doc, content: "Vague strategy. ".repeat(10) } : doc,
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ value: { documents: [...docs, { kind: "nonsense" }] } })
      .mockImplementation(review());
    const result = await personalizeOnboardingBrain(
      brief,
      research,
      Date.now() + 150_000,
      generate,
    );
    expect(result.brain.map((doc) => doc.kind)).toEqual(["profile", "instruction", "strategy"]);
    expect(result.personalChapters).toBe(2);
    warn.mockRestore();
    info.mockRestore();
  });

  it("asks once more for a required chapter the writer left out", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const docs = documents();
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ value: { documents: docs.filter((doc) => doc.kind === "profile") } })
      .mockResolvedValueOnce({ value: { documents: docs.filter((doc) => doc.kind !== "profile") } })
      .mockImplementation(review());
    const result = await personalizeOnboardingBrain(
      brief,
      research,
      Date.now() + 150_000,
      generate,
    );
    expect(generate.mock.calls[1][0].system).toMatch(/missing these required documents/);
    expect(result.personalChapters).toBe(3);
    expect(result.brain.map((doc) => doc.kind)).toEqual(["profile", "instruction", "strategy"]);
    info.mockRestore();
  });

  it("re-asks once only when the answer is not usable JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new AiStructuredOutputError("length"))
      .mockResolvedValueOnce({ value: { documents: documents() } })
      .mockImplementation(review());
    const result = await personalizeOnboardingBrain(
      brief,
      research,
      Date.now() + 150_000,
      generate,
    );
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.personalChapters).toBe(3);
    const provider = vi.fn().mockRejectedValue(new AiProviderRequestError(504, "openrouter"));
    await expect(
      personalizeOnboardingBrain(brief, research, Date.now() + 150_000, provider),
    ).rejects.toBeInstanceOf(AiProviderRequestError);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(brainOutputIssues(new Error("other"))).toBeNull();
    warn.mockRestore();
    info.mockRestore();
  });

  it("maps display-name kinds and records personal chapters on the session", async () => {
    expect(normalizeBrainDocumentKind("Writing voice")).toBe("instruction");
    expect(normalizeBrainDocumentKind("LinkedIn Strategy")).toBe("strategy");
    expect(normalizeBrainDocumentKind("horoscope")).toBe("horoscope");
    expect(onboardingBrainSchema(3).safeParse({ documents: [] }).success).toBe(false);
    const result = await prepareOnboardingBrain(
      brief,
      base,
      research,
      1,
      false,
      Date.now() + 150_000,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({ brain: base.brain, personalChapters: 2 }),
    );
    expect(result.personalization).toMatchObject({ status: "ready", personalChapters: 2 });
  });
});

it("never leaves snippet ids in Brain prose", () => {
  expect(stripEvidenceIds("I make mugs (e2). I teach on weekends [e3, e4].")).toBe(
    "I make mugs. I teach on weekends.",
  );
});

it("accepts a bare document or list from the writer", () => {
  const doc = { kind: "strategy", title: "Strategy", content: "x" };
  expect(onboardingBrainSchema().parse(doc).documents).toEqual([doc]);
  expect(onboardingBrainSchema().parse([doc]).documents).toEqual([doc]);
  expect(onboardingBrainSchema().parse({ documents: doc }).documents).toEqual([doc]);
});
