import { describe, expect, it } from "vitest";
import { communityMemberName, normalizeCommunityResources } from "./community-member";

describe("community member identity and resources", () => {
  it("uses the stored member identity and never trusts a post-supplied author name", () => {
    expect(
      communityMemberName({ member_name: "  Maya Chen  ", buyer_email: "x@example.com" }),
    ).toBe("Maya Chen");
    expect(communityMemberName({ member_name: null, buyer_email: "maya@example.com" })).toBe(
      "maya",
    );
  });

  it("only accepts a bounded list of credential-free HTTPS resources", () => {
    expect(
      normalizeCommunityResources([
        { label: "Guide", url: "https://example.com/guide" },
        { label: "Unsafe", url: "javascript:alert(1)" },
        { label: "Credentials", url: "https://user:pass@example.com/private" },
      ]),
    ).toEqual([{ label: "Guide", url: "https://example.com/guide" }]);
  });
});
