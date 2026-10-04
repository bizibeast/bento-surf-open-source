import { describe, expect, it } from "vitest";
import {
  contentConnectionIdSchema,
  contentDataDeletionSchema,
  contentResourceSelectionSchema,
} from "./content-connections.functions";

describe("Content connection action inputs", () => {
  it("bounds IDs, resource selection, and deletion intent", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(contentConnectionIdSchema.parse({ id })).toEqual({ id });
    expect(contentResourceSelectionSchema.parse({ id, resourceIds: ["page-1", "page-1"] })).toEqual(
      { id, resourceIds: ["page-1"] },
    );
    expect(contentDataDeletionSchema.parse({ id, includeConfirmedBrain: true })).toEqual({
      id,
      includeConfirmedBrain: true,
    });
    expect(() =>
      contentResourceSelectionSchema.parse({
        id,
        resourceIds: Array.from({ length: 101 }, (_, index) => `page-${index}`),
      }),
    ).toThrow();
  });
});
