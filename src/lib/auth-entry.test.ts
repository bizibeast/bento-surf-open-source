import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getClaims: vi.fn(),
  signOut: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getClaims: authMocks.getClaims, signOut: authMocks.signOut },
    from: authMocks.from,
  },
}));

import {
  authenticatedEntryDestination,
  clearOnboardedCache,
  readOnboardedCache,
  redirectAuthenticatedVisitor,
  rememberOnboarded,
} from "./auth-entry";

authMocks.from.mockReturnValue({
  select: () => ({
    eq: () => ({ maybeSingle: authMocks.maybeSingle }),
  }),
});

describe("authenticatedEntryDestination", () => {
  it("sends an onboarded creator to the dashboard", () => {
    expect(authenticatedEntryDestination(true)).toBe("/link");
  });

  it("preserves a safe requested destination", () => {
    expect(authenticatedEntryDestination(true, "/settings?section=plan")).toBe(
      "/settings?section=plan",
    );
  });

  it("does not loop an authenticated creator between public auth pages", () => {
    expect(authenticatedEntryDestination(true, "/login")).toBe("/link");
    expect(authenticatedEntryDestination(true, "/signup?campaign=summer")).toBe("/link");
  });

  it("sends an unfinished account back to onboarding", () => {
    expect(authenticatedEntryDestination(false, "/settings")).toBe("/onboarding");
  });

  it("rejects external redirect destinations", () => {
    expect(authenticatedEntryDestination(true, "https://example.com")).toBe("/link");
  });
});

describe("onboarded cache", () => {
  afterEach(() => {
    clearOnboardedCache();
    vi.clearAllMocks();
  });

  it("remembers onboarded status for the same user", () => {
    rememberOnboarded("user-1", true);
    expect(readOnboardedCache("user-1")).toBe(true);
  });

  it("does not leak onboarded status across users", () => {
    rememberOnboarded("user-1", true);
    expect(readOnboardedCache("user-2")).toBeNull();
  });

  it("clears on sign-out", () => {
    rememberOnboarded("user-1", true);
    clearOnboardedCache();
    expect(readOnboardedCache("user-1")).toBeNull();
  });
});

describe("auth entry recovery", () => {
  afterEach(() => {
    clearOnboardedCache();
    vi.clearAllMocks();
  });

  it("keeps login available when cached session claims are invalid", async () => {
    authMocks.getClaims.mockResolvedValue({ data: null, error: new Error("expired") });

    await expect(redirectAuthenticatedVisitor()).resolves.toBeUndefined();
    expect(authMocks.from).not.toHaveBeenCalled();
  });

  it("clears a locally invalid session instead of redirecting onboarding", async () => {
    authMocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
    authMocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied for table profiles" },
    });

    await expect(redirectAuthenticatedVisitor()).resolves.toBeUndefined();
    expect(authMocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("clears a session when PostgREST rejects its JWT", async () => {
    authMocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
    authMocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { code: "PGRST301", message: "No suitable key or wrong key type" },
    });

    await expect(redirectAuthenticatedVisitor()).resolves.toBeUndefined();
    expect(authMocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
