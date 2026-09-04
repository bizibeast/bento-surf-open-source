import { describe, expect, it } from "vitest";
import { shouldInvalidateRouterForAuthEvent } from "./auth-route-refresh";

describe("shouldInvalidateRouterForAuthEvent", () => {
  it("does not invalidate for the initial recovered session", () => {
    expect(shouldInvalidateRouterForAuthEvent("INITIAL_SESSION", "user-1", undefined)).toEqual({
      invalidate: false,
      nextUserId: "user-1",
    });
  });

  it("does not invalidate a SIGNED_IN that repeats the recovered user", () => {
    expect(shouldInvalidateRouterForAuthEvent("SIGNED_IN", "user-1", "user-1")).toEqual({
      invalidate: false,
      nextUserId: "user-1",
    });
  });

  it("does not invalidate a SIGNED_IN that arrives before INITIAL_SESSION", () => {
    expect(shouldInvalidateRouterForAuthEvent("SIGNED_IN", "user-1", undefined)).toEqual({
      invalidate: false,
      nextUserId: "user-1",
    });
  });

  it("invalidates a real sign-in after a signed-out initial session", () => {
    expect(shouldInvalidateRouterForAuthEvent("SIGNED_IN", "user-1", null)).toEqual({
      invalidate: true,
      nextUserId: "user-1",
    });
  });

  it("invalidates sign-out and profile updates", () => {
    expect(shouldInvalidateRouterForAuthEvent("SIGNED_OUT", null, "user-1")).toEqual({
      invalidate: true,
      nextUserId: null,
    });
    expect(shouldInvalidateRouterForAuthEvent("USER_UPDATED", "user-1", "user-1")).toEqual({
      invalidate: true,
      nextUserId: "user-1",
    });
  });

  it("ignores token refreshes", () => {
    expect(shouldInvalidateRouterForAuthEvent("TOKEN_REFRESHED", "user-1", "user-1")).toEqual({
      invalidate: false,
      nextUserId: "user-1",
    });
  });
});
