import { describe, expect, it } from "vitest";
import {
  parseTelegramUpdate,
  renderTelegramAgentResult,
  telegramActionId,
  telegramStartState,
} from "./telegram";

describe("Telegram protocol", () => {
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
