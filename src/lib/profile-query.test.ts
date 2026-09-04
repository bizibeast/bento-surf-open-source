import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_PROFILE_READ_ERROR,
  UPDATE_PROFILE_ERROR,
  USERNAME_CHANGE_COOLDOWN_ERROR,
  readPublicProfileResult,
  updateProfileWithRls,
} from "./profile-query";

describe("updateProfileWithRls", () => {
  it("performs exactly one authenticated update with the supplied user id and fields", async () => {
    const updated = { id: "user-1", username: "claimed_name" };
    const update = vi.fn().mockResolvedValue({ data: updated, error: null });

    await expect(
      updateProfileWithRls("user-1", { username: "claimed_name" }, update),
    ).resolves.toEqual(updated);

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith("user-1", {
      username: "claimed_name",
    });
  });

  it("treats PostgreSQL unique violations as the authoritative username conflict", async () => {
    const databaseError = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_username_key"',
      details: "Key (username)=(claimed_name) already exists.",
    };
    const update = vi.fn().mockResolvedValue({ data: null, error: databaseError });
    const logError = vi.fn();

    await expect(
      updateProfileWithRls("user-1", { username: "claimed_name" }, update, logError),
    ).rejects.toThrow("Username already taken");

    expect(update).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("Profile update failed", databaseError);
  });

  it("surfaces the username change cooldown without exposing other database errors", async () => {
    const databaseError = {
      code: "23514",
      message: USERNAME_CHANGE_COOLDOWN_ERROR,
    };

    await expect(
      updateProfileWithRls(
        "user-1",
        { username: "another_name" },
        vi.fn().mockResolvedValue({ data: null, error: databaseError }),
        vi.fn(),
      ),
    ).rejects.toThrow(USERNAME_CHANGE_COOLDOWN_ERROR);
  });

  it("logs other database errors without exposing their details", async () => {
    const databaseError = {
      code: "42501",
      message: "internal RLS policy detail",
    };
    const logError = vi.fn();

    await expect(
      updateProfileWithRls(
        "user-1",
        { bio: "hello" },
        vi.fn().mockResolvedValue({ data: null, error: databaseError }),
        logError,
      ),
    ).rejects.toThrow(UPDATE_PROFILE_ERROR);

    expect(logError).toHaveBeenCalledWith("Profile update failed", databaseError);
  });
});

describe("readPublicProfileResult", () => {
  it("returns successful query data", () => {
    expect(
      readPublicProfileResult("pages", {
        data: [{ id: "page-1" }],
        error: null,
      }),
    ).toEqual([{ id: "page-1" }]);
  });

  it.each(["profile", "pages", "blocks"] as const)(
    "logs and sanitizes a failed %s query",
    (resource) => {
      const databaseError = {
        code: "XX000",
        message: `${resource} backend detail`,
      };
      const logError = vi.fn();

      expect(() =>
        readPublicProfileResult(resource, { data: null, error: databaseError }, logError),
      ).toThrow(PUBLIC_PROFILE_READ_ERROR);
      expect(logError).toHaveBeenCalledWith(
        `Public profile ${resource} query failed`,
        databaseError,
      );
    },
  );
});
