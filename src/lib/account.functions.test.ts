import { describe, expect, it, vi } from "vitest";
import { deleteR2Prefix, hasRecentAuthenticationMethod } from "./account.functions";

describe("account deletion reauthentication", () => {
  it("requires a recent provider-signed authentication method timestamp", () => {
    expect(hasRecentAuthenticationMethod([{ method: "password", timestamp: 9_500 }], 10_000)).toBe(
      true,
    );
    expect(hasRecentAuthenticationMethod([{ method: "password", timestamp: 9_399 }], 10_000)).toBe(
      false,
    );
    expect(hasRecentAuthenticationMethod(["password"], 10_000)).toBe(false);
    expect(
      hasRecentAuthenticationMethod([{ method: "token_refresh", timestamp: 9_999 }], 10_000),
    ).toBe(false);
    expect(hasRecentAuthenticationMethod([{ method: "oauth", timestamp: 10_061 }], 10_000)).toBe(
      false,
    );
  });
});

describe("deleteR2Prefix", () => {
  it("deletes every paginated object under the prefix", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: "users/u/one" }],
        truncated: true,
        cursor: "next",
      })
      .mockResolvedValueOnce({ objects: [{ key: "users/u/two" }], truncated: false });
    const del = vi.fn().mockResolvedValue(undefined);
    const bucket = { list, delete: del } as unknown as R2Bucket;

    await deleteR2Prefix(bucket, "users/u/");

    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "users/u/",
      limit: 1_000,
      cursor: undefined,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "users/u/",
      limit: 1_000,
      cursor: "next",
    });
    expect(del).toHaveBeenCalledWith(["users/u/one"]);
    expect(del).toHaveBeenCalledWith(["users/u/two"]);
  });
});
