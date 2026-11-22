import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { studioStarter } from "./content-studio";
import {
  contentReferenceInput,
  referenceDraftInput,
  referenceDraftFromEvidence,
  referenceSourceUrl,
} from "./content-reference";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

describe("reference creation boundaries", () => {
  it("canonicalizes public Instagram references and rejects lookalike or credential URLs", () => {
    expect(referenceSourceUrl.parse("https://www.instagram.com/reel/Ab_c-12/?igsh=xyz")).toBe(
      "https://www.instagram.com/reel/Ab_c-12/",
    );
    for (const source of [
      "http://instagram.com/p/abc/",
      "https://instagram.com.evil.test/p/abc/",
      "https://u:p@instagram.com/p/abc/",
      "https://instagram.com:8443/p/abc/",
      "https://instagram.com/accounts/login/",
    ])
      expect(referenceSourceUrl.safeParse(source).success).toBe(false);
  });
  it("requires one source and explicit reference rights", () => {
    const input = {
      workspaceId,
      requestId,
      rightsConfirmed: true,
      sourceUrl: "https://instagram.com/p/abc/",
    };
    expect(contentReferenceInput.parse(input).mode).toBe("overview");
    expect(contentReferenceInput.safeParse({ ...input, mediaId: requestId }).success).toBe(false);
    expect(contentReferenceInput.safeParse({ workspaceId, requestId }).success).toBe(false);
    expect(contentReferenceInput.safeParse({ ...input, rightsConfirmed: false }).success).toBe(
      false,
    );
  });
  it("preserves the selected theme, makes original editable copy and never carries reference assets", () => {
    const seed = studioStarter("carousel", "split", {
      ...DEFAULT_AGENT_BRANDING,
      accentColor: "#aa3300",
    });
    const data = referenceDraftInput.parse({
      workspaceId,
      requestId,
      analysisId: requestId,
      prompt: "Use my niche",
      kind: "project",
      document: seed.document,
    });
    const result = referenceDraftFromEvidence(data, {
      format: "carousel",
      title: "My new guide",
      slides: [
        { heading: "A new hook", body: "My first lesson" },
        { heading: "Try it", body: "An original close" },
      ],
    });
    expect(result.document.format === "carousel" && result.document.layout).toBe("split");
    expect(result.document.brand).toEqual(seed.document.brand);
    expect(result.kind).toBe("project");
    expect(result.document.format === "carousel" && result.document.slides[0]).toEqual({
      heading: "A new hook",
      body: "My first lesson",
    });
    expect(result.revision).toBe(0);
  });
  it("stores templates as editable placeholder documents with no old media or generation IDs", () => {
    const seed = studioStarter("reel", "kinetic", DEFAULT_AGENT_BRANDING);
    if (seed.document.format !== "reel") throw Error("fixture");
    seed.document.scenes[0].mediaId = requestId;
    seed.document.scenes[0].avatarJobId = requestId;
    const data = referenceDraftInput.parse({
      workspaceId,
      requestId,
      analysisId: requestId,
      prompt: "Reusable hook and lesson structure",
      kind: "preset",
      document: seed.document,
    });
    const result = referenceDraftFromEvidence(data, {
      format: "reel",
      title: "Hook template",
      scenes: [
        {
          title: "[Your hook]",
          caption: "[Main promise]",
          duration: 5,
          speakerScript: "[Introduce your topic]",
          avatarVisible: false,
        },
      ],
    });
    expect(result.kind).toBe("preset");
    if (result.document.format !== "reel") throw Error("fixture");
    expect(result.document.style).toBe("kinetic");
    expect(result.document.scenes[0].mediaId).toBeNull();
    expect(result.document.scenes[0].avatarJobId).toBeNull();
    expect(result.document.scenes[0].avatarScript).toBe("[Introduce your topic]");
  });
});
