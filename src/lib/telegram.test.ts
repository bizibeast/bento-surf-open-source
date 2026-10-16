import { describe, expect, it } from "vitest";
import {
  parseTelegramUpdate,
  renderTelegramAgentResult,
  telegramActionId,
  telegramStartState,
  formatTelegramText,
} from "./telegram";

describe("Telegram protocol", () => {
  it("renders the agent's Markdown as readable native Telegram entities", () => {
    const formatted = formatTelegramText(
      "### Your voice\n\n- You're **bold** and direct.\n- Read [the source](https://example.com/story).\n\nUse `x < 3` safely.",
    );
    expect(formatted.text).toBe(
      "Your voice\n\n• You're bold and direct.\n• Read the source.\n\nUse x < 3 safely.",
    );
    const spans = formatted.entities.map((entity) => ({
      type: entity.type,
      text: formatted.text.slice(entity.offset, entity.offset + entity.length),
      url: entity.url,
    }));
    expect(spans).toEqual(
      expect.arrayContaining([
        { type: "bold", text: "Your voice", url: undefined },
        { type: "bold", text: "bold", url: undefined },
        { type: "text_link", text: "the source", url: "https://example.com/story" },
        { type: "code", text: "x < 3", url: undefined },
      ]),
    );
  });

  it("uses UTF-16 entity offsets and preserves handles, underscores and raw HTML safely", () => {
    const formatted = formatTelegramText(
      "👋 **Hello** @some_user <b>literal</b> [unsafe](javascript:alert)",
    );
    expect(formatted.text).toContain("@some_user <b>literal</b>");
    expect(formatted.entities[0]).toMatchObject({ type: "bold", offset: 3, length: 5 });
    expect(formatted.entities.some((item) => item.url?.startsWith("javascript:"))).toBe(false);
  });
  it("avoids invalid code entities nested inside a heading", () => {
    const formatted = formatTelegramText("### Use `example()` today");
    expect(formatted.text).toBe("Use example() today");
    expect(formatted.entities).toEqual([
      { type: "bold", offset: 0, length: formatted.text.length },
    ]);
  });
  it("accepts one bounded private text update", () => {
    expect(
      parseTelegramUpdate({
        update_id: 42,
        message: {
          message_id: 7,
          chat: { id: 99, type: "private", username: "creator" },
          text: "/start 11111111-1111-4111-8111-111111111111",
        },
      }).update_id,
    ).toBe(42);
  });

  it("rejects group messages, ambiguous updates, and oversized text", () => {
    expect(() =>
      parseTelegramUpdate({
        update_id: 43,
        message: { message_id: 8, chat: { id: -99, type: "group" }, text: "hello" },
      }),
    ).toThrow();
    expect(() =>
      parseTelegramUpdate({
        update_id: 44,
        message: {
          message_id: 9,
          chat: { id: 99, type: "private" },
          text: "x".repeat(4_097),
        },
      }),
    ).toThrow();
    expect(() => parseTelegramUpdate({ update_id: 45 })).toThrow();
  });

  it("parses only exact start and callback tokens", () => {
    expect(telegramStartState("/start 11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(telegramStartState("please /start 11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(telegramActionId("tg:22222222-2222-4222-8222-222222222222")).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(telegramActionId("schedule:everything")).toBeNull();
  });

  it("renders source URLs and keeps every response chunk within Telegram's limit", () => {
    const chunks = renderTelegramAgentResult({
      action: "research",
      message: "A".repeat(5_000),
      cards: [
        {
          type: "source",
          cardId: "source-1",
          title: "Source",
          url: "https://publisher.test/story",
          sourceName: "Publisher",
          publishedAt: "2026-09-19T00:00:00.000Z",
          summary: "Summary",
        },
      ],
    });
    expect(chunks.join("\n")).toContain("https://publisher.test/story");
    expect(chunks.every((chunk) => chunk.length <= 4_096)).toBe(true);
  });
});
