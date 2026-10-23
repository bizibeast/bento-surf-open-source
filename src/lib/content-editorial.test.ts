import { describe, expect, it } from "vitest";
import {
  buildEditorialBrief,
  validateEditorialDraft,
  type EditorialContext,
} from "./content-editorial";

export const context: EditorialContext = {
  now: "2026-10-12T12:00:00Z",
  platform: "twitter",
  request: "A lesson about small releases",
  brain: [
    {
      id: "voice",
      kind: "instruction",
      status: "confirmed",
      content: "Plain, direct sentences. No hype.",
    },
  ],
  sources: [
    {
      id: "launch",
      title: "Episode 4: launch",
      text: "In January 2024 I launched a small prototype and interviewed customers.",
      occurredAt: "2024-01-10T00:00:00Z",
      external: false,
    },
  ],
  recentOutputs: [
    { id: "old", body: "Ship small to learn faster. A narrow release makes feedback useful." },
  ],
};
export const draft = (body: string) => ({
  platform: "twitter",
  format: "post",
  body,
  sourceUrls: [],
  claims: [],
});
const codes = (body: string) =>
  validateEditorialDraft(
    buildEditorialBrief(context),
    draft(body),
    context.recentOutputs || [],
  ).map((i) => i.code);

it("allows a bold curiosity hook and CTA when the post delivers useful advice", () => {
  expect(
    codes(
      "The secret nobody tells you about launching: test one useful workflow with a real user before adding features. Ask where they get stuck. Agree? Comment YES below!",
    ),
  ).not.toContain("formulaic");
});

it.each([
  ["unknown source", { sourceId: "missing" }, "source reference"],
  ["paraphrased quote", { quote: "I shipped a tiny prototype" }, "quote"],
  ["empty quote", { quote: "   " }, "quote"],
  ["edited claim", { text: "I interviewed users" }, "text"],
] as const)("identifies the claim field that needs repair: %s", (_name, change, field) => {
  const claim = {
    sourceId: "launch",
    text: "I launched a small prototype",
    quote: "I launched a small prototype",
  };
  const issues = validateEditorialDraft(
    buildEditorialBrief(context),
    {
      ...draft("In January 2024 I launched a small prototype."),
      claims: [{ ...claim, ...change }],
    },
    [],
  );
  const message = issues.find((issue) => issue.code === "unsupported_claim")?.message;
  expect(message).toContain("Claim 1");
  expect(message).toContain(field);
});

it("reports each invalid claim so one repair can fix the whole draft", () => {
  const issues = validateEditorialDraft(
    buildEditorialBrief(context),
    {
      ...draft("In January 2024 I launched a small prototype and interviewed customers."),
      claims: [
        { sourceId: "missing", text: "I launched a small prototype", quote: "a small prototype" },
        { sourceId: "launch", text: "interviewed customers", quote: "interviewed 20 customers" },
      ],
    },
    [],
  );
  const message = issues.find((issue) => issue.code === "unsupported_claim")?.message;
  expect(message).toContain("Claim 1");
  expect(message).toContain("Claim 2");
  expect(message).toContain("source reference");
  expect(message).toContain("quote");
  expect(message).not.toContain("20 customers");
});

it("applies X weights to source links and non-Latin text", () => {
  expect(codes(`${"a".repeat(255)} https://example.com/${"path".repeat(60)}`)).not.toContain(
    "provider_limit",
  );
  expect(codes("界".repeat(141))).toContain("provider_limit");
});

it("accepts equivalent quote typography and spacing without changing source wording", () => {
  const brief = buildEditorialBrief({
    ...context,
    sources: [
      {
        id: "report",
        title: "Notes",
        text: "Acme said: “We shipped\n10 tools.”",
        occurredAt: null,
        external: false,
      },
    ],
  });
  const text = 'Acme said: "We shipped 10 tools."';
  const claim = {
    sourceId: "report",
    text: "“We shipped 10 tools.”",
    quote: '"We shipped 10 tools."',
  };
  const checked = (quote: string) =>
    validateEditorialDraft(brief, { ...draft(text), claims: [{ ...claim, quote }] }, []);
  expect(checked(claim.quote).map((issue) => issue.code)).not.toContain("unsupported_claim");
  expect(checked('"We shipped 100 tools."').map((issue) => issue.code)).toContain(
    "unsupported_claim",
  );
  expect(checked('"We did not ship 10 tools."').map((issue) => issue.code)).toContain(
    "unsupported_claim",
  );
  expect(checked("         ").map((issue) => issue.code)).toContain("unsupported_claim");
});

describe("editorial briefing and deterministic gate", () => {
  it("keeps recent Discover evidence when a large historical Brain fills the context", () => {
    const sources = Array.from({ length: 20 }, (_, index) => ({
      ...context.sources[0],
      id: `old-${index}`,
    }));
    const fresh = {
      id: "discover:new",
      title: "A current development",
      text: "A new public release relevant to the creator.",
      external: true,
      occurredAt: "2026-10-15T10:00:00Z",
      url: "https://example.com/release",
    };
    const brief = buildEditorialBrief({
      ...context,
      now: "2026-10-16T00:00:00Z",
      sources: [...sources, fresh],
      platform: "linkedin",
      representativePosts: [
        { id: "x", platform: "twitter", body: "A short tweet." },
        { id: "li", platform: "linkedin", body: "My LinkedIn voice." },
      ],
    });
    expect(brief.sources).toHaveLength(12);
    expect(brief.sourceIds).toContain(fresh.id);
    expect(brief.voiceProfile.examples[0]).toBe("My LinkedIn voice.");
  });

  it("bounds a large multilingual evidence pack before reserving paid AI usage", () => {
    const huge = "想法".repeat(6000);
    const brief = buildEditorialBrief({
      ...context,
      sources: Array.from({ length: 30 }, (_, i) => ({
        ...context.sources[0],
        id: String(i),
        text: huge,
      })),
      representativePosts: Array.from({ length: 12 }, (_, i) => ({ id: String(i), body: huge })),
      recentOutputs: Array.from({ length: 60 }, (_, i) => ({ id: String(i), body: huge })),
      brain: Array.from({ length: 30 }, () => ({
        kind: "instruction",
        status: "confirmed",
        content: huge,
      })),
    });
    expect(new TextEncoder().encode(JSON.stringify(brief)).length).toBeLessThan(100000);
  });
  it("keeps source age, confirmed voice and one durable angle", () => {
    const brief = buildEditorialBrief({
      ...context,
      brain: [...context.brain, { status: "suggested", content: "Use hype" }],
    });
    expect(brief.sources[0]).toMatchObject({ id: "launch", freshness: "historical" });
    expect(brief.voiceProfile.instructions.join(" ")).not.toContain("Use hype");
    expect(brief.angle).toBeTruthy();
    expect(brief.claimsAllowed).toContain("launch");
  });
  it.each([
    "Episode 5: another lesson.",
    "Launching today: the prototype is here!",
    "Join my event tomorrow.",
    "Just shipped a new tool. Builders: check read_workspace_data",
  ])("rejects stale serial/current event language: %s", (body) => {
    expect(codes(body)).toContain("stale_context");
  });
  it("rejects raw internal tool names in automatic post copy", () => {
    expect(codes("Builders: check read_workspace_data for your next post.")).toContain(
      "internal_jargon",
    );
  });
  it("requires a cited current signal for automatic trend drafts", () => {
    const current = {
      id: "trend:news",
      title: "A startup funding announcement",
      text: "A startup announced a new funding round on October 17.",
      occurredAt: "2026-10-17T12:00:00Z",
      url: "https://example.com/news",
      sourceName: "Example News",
      external: true,
    };
    const brief = buildEditorialBrief({
      ...context,
      now: "2026-10-18T12:00:00Z",
      sources: [current, ...context.sources],
      requiredRecentSourceIds: [current.id],
    });
    const unsourced = validateEditorialDraft(
      brief,
      { ...draft("A practical lesson from my own launch."), sourceIds: ["launch"] },
      [],
    ).map((issue) => issue.code);
    expect(unsourced).toContain("current_source");
    const unattributed = validateEditorialDraft(
      brief,
      {
        ...draft(
          "A startup announced a new funding round on October 17. What would you test before spending it?",
        ),
        sourceIds: [current.id],
        sourceUrls: [current.url],
        claims: [
          {
            text: "A startup announced a new funding round on October 17",
            sourceId: current.id,
            quote: "A startup announced a new funding round on October 17",
          },
        ],
      },
      [],
    ).map((issue) => issue.code);
    expect(unattributed).toContain("source_attribution");
    const grounded = validateEditorialDraft(
      brief,
      {
        ...draft(
          "Example News reports: A startup announced a new funding round on October 17. What would you test before spending it?",
        ),
        sourceIds: [current.id],
        sourceUrls: [current.url],
        claims: [
          {
            text: "A startup announced a new funding round on October 17",
            sourceId: current.id,
            quote: "A startup announced a new funding round on October 17",
          },
        ],
      },
      [],
    ).map((issue) => issue.code);
    expect(grounded).not.toContain("current_source");
    expect(grounded).not.toContain("source_attribution");
  });
  it("accepts a new durable lesson and dated historical facts", () => {
    expect(codes("I think interviews work best when each question tests one assumption.")).toEqual(
      [],
    );
    expect(
      validateEditorialDraft(
        buildEditorialBrief(context),
        {
          ...draft("In January 2024 I launched a small prototype."),
          claims: [
            {
              text: "In January 2024 I launched a small prototype",
              sourceId: "launch",
              quote: "In January 2024 I launched a small prototype",
            },
          ],
        },
        [],
      ).map((i) => i.code),
    ).toEqual([]);
  });
  it("rejects a copied hook", () =>
    expect(codes("Ship small to learn faster. Here is another reason to do it.")).toContain(
      "copied_hook",
    ));
  it("rejects em dashes in a post and in carousel copy, even when a voice sample uses one", () => {
    const brief = buildEditorialBrief({
      ...context,
      representativePosts: [
        { id: "popular", body: `A thought${String.fromCodePoint(0x2014)}then a lesson.` },
      ],
    });
    expect(
      validateEditorialDraft(
        brief,
        draft(`A small release${String.fromCodePoint(0x2014)}one useful question.`),
        [],
      ).map((issue) => issue.code),
    ).toContain("voice_drift");
    const carousel = buildEditorialBrief({ ...context, platform: "instagram" });
    expect(
      validateEditorialDraft(
        carousel,
        {
          ...draft("One useful idea for a carousel."),
          platform: "instagram",
          format: "carousel",
          title: `One idea${String.fromCodePoint(0x2014)}three lessons`,
          slides: [
            { heading: "A small release", body: "Choose one question." },
            {
              heading: "Keep learning",
              body: `Use feedback${String.fromCodePoint(0x2014)}then revise.`,
            },
          ],
        },
        [],
      ).map((issue) => issue.code),
    ).toContain("voice_drift");
  });
  it.each([
    "I grew revenue by 90%.",
    "I interviewed 500 customers.",
    "I launched a business yesterday.",
  ])("rejects unsupported metrics and experiences: %s", (body) =>
    expect(codes(body)).toContain("unsupported_claim"),
  );
  it("requires external provenance", () => {
    const brief = buildEditorialBrief({
      ...context,
      sources: [{ ...context.sources[0], external: true, url: "https://example.com/research" }],
    });
    expect(
      validateEditorialDraft(
        brief,
        { ...draft("A useful lesson from this study."), sourceIds: ["launch"] },
        [],
      ).map((i) => i.code),
    ).toContain("missing_source");
  });
  it("rejects generic engagement bait", () =>
    expect(codes("Agree? Comment YES below!")).toContain("formulaic"));
  it("accepts concise X and a complete LinkedIn post, enforces provider lengths", () => {
    expect(
      codes(
        "A prototype should answer a question. Pick the question before choosing the features.",
      ),
    ).toEqual([]);
    const brief = buildEditorialBrief({ ...context, platform: "linkedin" });
    expect(
      validateEditorialDraft(
        brief,
        {
          ...draft(
            "A small release is useful when it tests one assumption.\n\nWrite the question before the feature list. Then ask customers to try the smallest version that can answer it.\n\nThe answer gives your next release a purpose.",
          ),
          platform: "linkedin",
        },
        [],
      ),
    ).toEqual([]);
    expect(codes("x".repeat(281))).toContain("provider_limit");
  });
});

it("cites only the used source when more than five external sources are available", () => {
  const brief = buildEditorialBrief({
    ...context,
    sources: Array.from({ length: 8 }, (_, i) => ({
      id: `source-${i}`,
      title: "Interview research",
      text: "Customer interviews reveal hidden assumptions about products.",
      occurredAt: "2026-10-01T00:00:00Z",
      external: true,
      url: `https://example.com/research/${i}`,
    })),
  });
  expect(brief.sources.length).toBeGreaterThan(5);
  expect(
    validateEditorialDraft(
      brief,
      {
        ...draft("Try asking about the last time a customer solved the problem."),
        sourceIds: ["source-0"],
        sourceUrls: ["https://example.com/research/0"],
      },
      [],
    ),
  ).toEqual([]);
});
it("rejects copied historical hooks even when they are absent from recent saved outputs", () => {
  const brief = buildEditorialBrief({
    ...context,
    sources: [
      {
        ...context.sources[0],
        text: "A narrow release makes feedback useful. It keeps interviews focused on a single question.",
      },
    ],
  });
  expect(
    validateEditorialDraft(
      brief,
      draft("A narrow release makes feedback useful. Here is a different closing line."),
      [],
    ).map((issue) => issue.code),
  ).toContain("copied_hook");
});
it("rejects a bare engagement question", () => expect(codes("Agree?")).toContain("formulaic"));
it("does not let unrelated fresh evidence turn an old launch into news", () => {
  const brief = buildEditorialBrief({
    ...context,
    sources: [
      ...context.sources,
      {
        id: "unrelated",
        title: "A different event",
        text: "Join today",
        occurredAt: context.now!,
        external: false,
      },
    ],
  });
  expect(
    validateEditorialDraft(
      brief,
      { ...draft("The prototype is launching today!"), sourceIds: ["launch"] },
      [],
    ).map((issue) => issue.code),
  ).toContain("stale_context");
});

it("allows intended target reuse while checking unrelated drafts and factual claims", () => {
  const original =
    "A prototype should answer one question. Pick the question before choosing the features and use feedback to guide the next release.";
  const target = {
    id: "message:card",
    messageId: "message",
    cardId: "card",
    platform: "twitter",
    format: "post",
    body: original,
    sourceIds: ["launch"],
    sourceUrls: [],
    sources: context.sources,
  };
  const revised = draft(
    "A prototype should answer one question. Choose the question before the features.",
  );
  const brief = buildEditorialBrief({
    ...context,
    revisionTarget: target,
    recentOutputs: [{ id: target.id, body: original }],
  });
  expect(brief.revisionTarget?.sources).toEqual(context.sources);
  expect(validateEditorialDraft(brief, revised, [{ id: target.id, body: original }])).toEqual([]);
  expect(
    validateEditorialDraft(brief, revised, [{ id: "unrelated", body: original }]).map(
      (issue) => issue.code,
    ),
  ).toContain("copied_hook");
  expect(
    validateEditorialDraft(brief, draft("I grew revenue by 90%."), []).map((issue) => issue.code),
  ).toContain("unsupported_claim");
  expect(
    validateEditorialDraft(brief, { ...revised, format: "thread" }, []).map((issue) => issue.code),
  ).toContain("format");
});
it("exempts verified ancestors on successive edits but never an unrelated matching hook", () => {
  const body = "A prototype should answer one question. Pick a small test.";
  const target = {
    id: "B:draft",
    messageId: "B",
    cardId: "draft",
    platform: "twitter",
    format: "post",
    body,
    sourceIds: [],
    sourceUrls: [],
    sources: [],
    ancestorIds: ["A:draft"],
  };
  const outputs = [
    { id: "A:draft", body },
    { id: "B:draft", body },
  ];
  const brief = buildEditorialBrief({ ...context, revisionTarget: target, recentOutputs: outputs });
  const edited = draft("A prototype should answer one question. Start with the simplest test.");
  expect(brief.recentOutputs).toEqual([]);
  expect(validateEditorialDraft(brief, edited, outputs)).toEqual([]);
  expect(
    validateEditorialDraft(brief, edited, [...outputs, { id: "unrelated", body }]).map(
      (issue) => issue.code,
    ),
  ).toContain("copied_hook");
  expect(
    validateEditorialDraft(brief, draft("I grew revenue by 90%."), outputs).map(
      (issue) => issue.code,
    ),
  ).toContain("unsupported_claim");
});
