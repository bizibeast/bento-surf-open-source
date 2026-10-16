import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Unit tests use provider fakes. The real fail-closed reservation and SQL concurrency
// are exercised separately in provider-budget.server.test.ts and the database test.
vi.mock("@/lib/provider-budget.server", async (original) => ({
  ...(await original<typeof import("@/lib/provider-budget.server")>()),
  reserveProviderUsage: vi.fn().mockResolvedValue(undefined),
  reserveXRead: vi.fn().mockResolvedValue(undefined),
  xBackgroundReadsEnabled: vi.fn().mockReturnValue(true),
}));
