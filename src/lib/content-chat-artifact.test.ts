import { expect, it } from "vitest";
import { chatArtifactFromReceipt, chatCreationSummary } from "./content-chat-artifact";
const id = "00000000-0000-4000-8000-000000000001";
it("exposes only a validated artifact ID from supported creation receipts", () => {
  expect(
    chatArtifactFromReceipt("save_content_studio_project", {
      entry: { id, document: { code: "secret" } },
    }),
  ).toEqual({ entryId: id });
  expect(
    chatArtifactFromReceipt("prepare_reel_production", { production: { entryId: id } }),
  ).toEqual({ entryId: id });
  expect(
    chatArtifactFromReceipt("create_content_from_reference", { result: { entry: { id } } }),
  ).toEqual({ entryId: id });
  expect(
    chatArtifactFromReceipt("revise_content_studio_copy", {
      entry: { id, document: { scenes: [] } },
    }),
  ).toEqual({ entryId: id });
  expect(chatArtifactFromReceipt("create_social_post", { entry: { id } })).toBeUndefined();
  expect(
    chatArtifactFromReceipt("save_content_studio_project", { entry: { id: "not-an-id" } }),
  ).toBeUndefined();
});
it("summarizes a draft without showing its timeline or implementation fields", () => {
  const summary = chatCreationSummary({
    title: "My reel",
    document: { schemaVersion: 1, scenes: [{ code: "hidden" }], caption: "A better hook" },
  });
  expect(summary).toEqual({ title: "My reel", summary: "A better hook" });
  expect(
    chatCreationSummary({
      entryId: id,
      revision: 2,
      draft: {
        format: "reel",
        title: "A revised reel",
        scenes: [{ sourceSceneId: id, duration: 5, speakerScript: "The new spoken line" }],
      },
    }),
  ).toEqual({ title: "A revised reel", summary: "The new spoken line" });
});
