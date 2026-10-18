import { describe, expect, it, vi } from "vitest";
import { buildManualCandidates, onboardingBriefSchema } from "./brief";
import {
  onboardingBrainSources,
  onboardingSampleIds,
  type OnboardingResearch,
} from "./research.server";
import {
  onboardingBrainSchema,
  personalizeOnboardingBrain,
  prepareOnboardingBrain,
} from "./personalization.server";
import { onboardingProfile } from "./evidence";

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
  it("uses one bounded AI call and adds source links only after validation", async () => {
    const generate = vi.fn().mockResolvedValue({ value: { documents: documents() } });
    const result = await personalizeOnboardingBrain(brief, research, Date.now() + 90000, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].maxTokens).toBe(6000);
    expect(generate.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(40000);
    expect(JSON.stringify(generate.mock.calls[0][0].input)).not.toContain("https://");
    expect(result[0].content).toContain("Source notes");
  });
});

describe("personalization recovery and caps", () => {
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
    const edited = {
      ...ready,
      brain: ready.brain.map((d) => ({ ...d, content: `${d.content}\nCreator edit.` })),
    };
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
