import { describe, expect, it } from "vitest";
import { profileUpdateSchema, sanitizePublicProfileBlocks } from "./profile.functions";

describe("profileUpdateSchema", () => {
  it("preserves a creator's search-engine visibility preference", () => {
    expect(profileUpdateSchema.parse({ noindex: true })).toEqual({ noindex: true });
    expect(profileUpdateSchema.parse({ noindex: false })).toEqual({ noindex: false });
  });
});

describe("public profile block serialization", () => {
  it("strips newsletter linkage without mutating stored block content", () => {
    const stored = [
      {
        id: "capture",
        type: "email_capture",
        content: {
          title: "Join Studio Notes",
          newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
        },
      },
    ];
    expect(sanitizePublicProfileBlocks(stored as never)).toEqual([
      { id: "capture", type: "email_capture", content: { title: "Join Studio Notes" } },
    ]);
    expect(stored[0].content.newsletterPublicationId).toBe("11111111-1111-4111-8111-111111111111");
  });
});
