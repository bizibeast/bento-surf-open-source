import { describe, expect, it, vi } from "vitest";
import { verifyBrainDocuments } from "./content-brain-verification.server";

const sources = [
  { id: "post-1", text: "I made a video reviewing Instinct, an app built by another team." },
];
const documents = [
  {
    id: "brain-1",
    kind: "profile",
    title: "My Human",
    content: "I developed the Instinct app.",
    evidence: [{ sourceId: "post-1", quote: "I made a video reviewing Instinct" }],
  },
];
const response = (approved: boolean) => ({
  value: {
    reviews: [
      {
        id: "brain-1",
        approved,
        sourceIds: ["post-1"],
        issues: approved ? [] : ["Reviewing an app does not establish authorship."],
      },
    ],
  },
});

describe("independent Brain evidence review", () => {
  it("rejects reviewer-to-builder attribution despite an exact source quote", async () => {
    const generate = vi.fn().mockResolvedValue(response(false));
    await expect(verifyBrainDocuments({ documents, sources }, {}, generate)).rejects.toThrow(
      "could not be verified",
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].input.documents[0].content).toBe(
      "I developed the Instinct app.",
    );
    expect(generate.mock.calls[0][0].system).toContain("reviewing");
  });
  it("checks the full document, including factual statements omitted from a generated claim list", async () => {
    const generate = vi.fn().mockResolvedValue(response(false));
    await expect(
      verifyBrainDocuments(
        {
          documents: [
            {
              ...documents[0],
              content:
                "I made a video reviewing Instinct. I also founded its parent company and raised $10 million.",
            },
          ],
          sources,
        },
        {},
        generate,
      ),
    ).rejects.toThrow("could not be verified");
    expect(generate.mock.calls[0][0].input.documents[0].content).toContain("$10 million");
  });
  it("accepts a supported reviewer description without rewriting it", async () => {
    const generate = vi.fn().mockResolvedValue(response(true));
    await expect(
      verifyBrainDocuments(
        {
          documents: [{ ...documents[0], content: "I made a video reviewing Instinct." }],
          sources,
        },
        {},
        generate,
      ),
    ).resolves.toBeUndefined();
    expect(generate.mock.calls[0][0]).toMatchObject({
      maxTokens: 2000,
      timeoutMs: 15000,
      modelTier: "balanced",
    });
  });
  it.each([
    { reviews: [] },
    { reviews: [response(true).value.reviews[0], response(true).value.reviews[0]] },
    { reviews: [{ ...response(true).value.reviews[0], sourceIds: ["invented"] }] },
    { reviews: [{ ...response(true).value.reviews[0], issues: ["Unsupported ownership"] }] },
  ])("rejects incomplete or inconsistent review output", async (value) => {
    const generate = vi.fn().mockResolvedValue({ value });
    await expect(verifyBrainDocuments({ documents, sources }, {}, generate)).rejects.toThrow();
  });
  it("includes confirmed creator corrections as authoritative facts and stops on verifier failure", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("AI budget unavailable"));
    await expect(
      verifyBrainDocuments(
        {
          documents,
          sources,
          corrections: [
            { title: "Ownership correction", content: "I reviewed Instinct; I did not build it." },
          ],
        },
        {},
        generate,
      ),
    ).rejects.toThrow("AI budget unavailable");
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].input.corrections[0].content).toContain("did not build");
  });
  it("does not spend when the review cannot fit the bounded context or remaining deadline", async () => {
    const generate = vi.fn();
    await expect(
      verifyBrainDocuments(
        { documents: [{ ...documents[0], content: "x".repeat(100001) }], sources },
        {},
        generate,
      ),
    ).rejects.toThrow();
    await expect(
      verifyBrainDocuments({ documents, sources, deadline: Date.now() }, {}, generate),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});
