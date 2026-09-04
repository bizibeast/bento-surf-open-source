import { describe, expect, it, vi } from "vitest";
import { checkUsernameAvailability } from "./username-availability";
import { normalizeUsername, usernameSchema } from "./username";

describe("username rules", () => {
  it("normalizes and validates usernames through the canonical schema", () => {
    expect(normalizeUsername("Mixed_CASE12")).toBe("mixed_case12");
    expect(usernameSchema.parse("Mixed_CASE12")).toBe("mixed_case12");
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("not-valid!").success).toBe(false);
  });
});

describe("checkUsernameAvailability", () => {
  it("validates the username before querying", async () => {
    const findExisting = vi.fn();

    await expect(checkUsernameAvailability("ab", findExisting)).rejects.toThrow();
    await expect(checkUsernameAvailability("not-valid!", findExisting)).rejects.toThrow();
    expect(findExisting).not.toHaveBeenCalled();
  });

  it("lowercases a valid username before querying", async () => {
    const findExisting = vi.fn().mockResolvedValue(null);

    await checkUsernameAvailability("Mixed_CASE12", findExisting);

    expect(findExisting).toHaveBeenCalledOnce();
    expect(findExisting).toHaveBeenCalledWith("mixed_case12");
  });

  it("reports an unused username as available", async () => {
    await expect(checkUsernameAvailability("new_user", async () => null)).resolves.toEqual({
      available: true,
    });
  });

  it("reports an existing username as taken", async () => {
    await expect(
      checkUsernameAvailability("existing", async () => ({ id: "profile-id" })),
    ).resolves.toEqual({ available: false });
  });

  it("logs backend query errors but returns only a generic public error", async () => {
    const backendError = new Error("database unavailable");
    const logError = vi.fn();

    await expect(
      checkUsernameAvailability(
        "some_user",
        async () => {
          throw backendError;
        },
        logError,
      ),
    ).rejects.toThrow("Unable to check username availability");
    expect(logError).toHaveBeenCalledWith("Username availability lookup failed", backendError);
  });
});
