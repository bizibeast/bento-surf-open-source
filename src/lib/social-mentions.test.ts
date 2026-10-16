import { describe, expect, it } from "vitest";
import {
  insertSocialMention,
  mentionQueryAtCursor,
  remapSocialMentions,
  renderSocialMentions,
  validSocialMentions,
  type SocialMention,
} from "./social-mentions";

describe("scheduler mentions", () => {
  it("finds the account being typed at the caret", () => {
    expect(mentionQueryAtCursor("Thanks @Acme Te", 15)).toEqual({
      start: 7,
      end: 15,
      query: "Acme Te",
    });
    expect(mentionQueryAtCursor("Thanks @Acme, today", 19)).toBeNull();
    expect(mentionQueryAtCursor("Hola @José-Pérez", 16)).toEqual({
      start: 5,
      end: 16,
      query: "José-Pérez",
    });
    expect(mentionQueryAtCursor("Thanks @Acme team", 17, "twitter")).toEqual({
      start: 7,
      end: 17,
      query: "Acme team",
    });
    expect(mentionQueryAtCursor("Thanks @Y Combinator", 20, "twitter")).toEqual({
      start: 7,
      end: 20,
      query: "Y Combinator",
    });
  });

  it("keeps a selected Page attached to its text while nearby copy changes", () => {
    const inserted = insertSocialMention(
      "Hi @Ac",
      { start: 3, end: 6 },
      {
        provider: "facebook",
        id: "12345",
        name: "Acme Studio",
        handle: null,
        kind: "page",
        verified: true,
      },
    );
    expect(inserted.value).toBe("Hi @Acme Studio");
    const expanded = `Today, ${inserted.value}!`;
    const moved = remapSocialMentions(inserted.value, expanded, [inserted.mention]);
    expect(renderSocialMentions(expanded, "facebook", moved)).toBe("Today, Hi @[12345]!");
    expect(remapSocialMentions(expanded, "Today, Hi @Another Studio!", moved)).toEqual([]);
  });

  it("renders LinkedIn URNs only for a matching selected mention", () => {
    const body = "Thanks @Jane Smith and @Acme";
    const mentions: SocialMention[] = [
      {
        provider: "linkedin",
        id: "urn:li:person:abc_123",
        name: "Jane Smith",
        handle: null,
        text: "@Jane Smith",
        start: 7,
        end: 18,
        kind: "person",
        verified: true,
      },
      {
        provider: "linkedin",
        id: "urn:li:organization:42",
        name: "Acme",
        handle: null,
        text: "@Acme",
        start: 23,
        end: 28,
        kind: "page",
        verified: true,
      },
    ];
    expect(renderSocialMentions(body, "linkedin", mentions)).toBe(
      "Thanks @[Jane Smith](urn:li:person:abc_123) and @[Acme](urn:li:organization:42)",
    );
    expect(renderSocialMentions(body, "twitter", mentions)).toBe(body);
    expect(validSocialMentions(body.replace("Jane", "Janet"), "linkedin", mentions)).toHaveLength(
      0,
    );
  });

  it("leaves manual text and malformed provider IDs untouched", () => {
    const body = "Hi @Acme";
    expect(
      renderSocialMentions(body, "facebook", [
        {
          provider: "facebook",
          id: "not-an-id",
          name: "Acme",
          handle: null,
          text: "@Acme",
          start: 3,
          end: 8,
          kind: "page",
          verified: true,
        },
      ]),
    ).toBe(body);
    expect(
      renderSocialMentions(body, "facebook", [
        {
          provider: "facebook",
          id: "123",
          name: "Acme",
          handle: "Acme",
          text: "@Acme",
          start: 3,
          end: 8,
          kind: "handle",
          verified: false,
        },
      ]),
    ).toBe(body);
  });
});
