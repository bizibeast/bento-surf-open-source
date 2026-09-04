import { describe, expect, it, vi } from "vitest";
import {
  clearPendingUsername,
  getPendingUsername,
  getUsernameClaimError,
  selectOnboardingUsername,
  storePendingUsername,
} from "./pending-username";

function storageWith(value: string | null = null): Storage {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: value === null ? 0 : 1,
  };
}

describe("pending username", () => {
  it("stores only a valid normalized username before authentication", () => {
    const storage = storageWith();

    expect(storePendingUsername(storage, "Selected_Name")).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith("pending_username", "selected_name");
    expect(storePendingUsername(storage, "no!")).toBe(false);
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it("reads valid values and rejects malformed storage values", () => {
    expect(getPendingUsername(storageWith("selected_name"))).toBe("selected_name");
    expect(getPendingUsername(storageWith("not valid!"))).toBeNull();
  });

  it("prefers a valid pending selection over the generated profile username", () => {
    expect(selectOnboardingUsername("generated_123", "selected_name")).toBe("selected_name");
    expect(selectOnboardingUsername("generated_123", "invalid!")).toBe("generated_123");
    expect(selectOnboardingUsername(null, null)).toBe("");
  });

  it("maps the authoritative unique conflict separately from other claim failures", () => {
    expect(getUsernameClaimError(new Error("Username already taken"))).toBe(
      "That username was just claimed. Choose another one.",
    );
    expect(getUsernameClaimError(new Error("network failure"))).toBe(
      "Couldn’t claim that username. Please try again.",
    );
  });

  it("clears the pending selection only when explicitly requested", () => {
    const storage = storageWith("selected_name");
    clearPendingUsername(storage);
    expect(storage.removeItem).toHaveBeenCalledWith("pending_username");
  });

  it("fails safely when browser storage is unavailable", () => {
    const storage = storageWith();
    vi.mocked(storage.getItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(storage.setItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(storage.removeItem).mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(getPendingUsername(storage)).toBeNull();
    expect(storePendingUsername(storage, "selected_name")).toBe(false);
    expect(() => clearPendingUsername(storage)).not.toThrow();
  });
});
