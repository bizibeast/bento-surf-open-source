import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveXRead, ProviderBudgetError } from "./provider-budget.server";
import { fetchXAccountCapabilities } from "./x-account.server";

const db = vi.hoisted(() => ({ from: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));

describe("X capability lookup cost", () => {
  const connection = {
    id: "connection-1",
    user_id: "workspace-1",
    metadata: {
      x_subscription_type: "Premium",
      x_capabilities_checked_at: "2026-10-14T12:00:00Z",
    },
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    vi.mocked(reserveXRead).mockReset().mockResolvedValue(undefined);
    db.from.mockReset().mockReturnValue(db);
    db.update.mockReset().mockReturnValue(db);
    db.eq
      .mockReset()
      .mockReturnValue({
        ...db,
        then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
      });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { subscription_type: "Premium" } })),
        ),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses recent verified privileges without another paid read", async () => {
    expect((await fetchXAccountCapabilities("token", connection)).canPostLong).toBe(true);
    expect(reserveXRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each(["2026-10-01T12:00:00Z", "2027-10-01T12:00:00Z"])(
    "refreshes stale or invalid cache dates (%s) once and persists the result",
    async (date) => {
      await fetchXAccountCapabilities("token", {
        ...connection,
        metadata: { ...connection.metadata, x_capabilities_checked_at: date },
      });
      expect(reserveXRead).toHaveBeenCalledWith("https://api.x.com/2/users/me", connection.user_id);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(db.update).toHaveBeenCalledWith({
        metadata: expect.objectContaining({
          x_capabilities_checked_at: "2026-10-15T12:00:00.000Z",
        }),
      });
      expect(db.eq).toHaveBeenCalledWith("user_id", connection.user_id);
    },
  );

  it("does not contact X when the identity budget denies the refresh", async () => {
    vi.mocked(reserveXRead).mockRejectedValueOnce(new ProviderBudgetError("x_identity_reads"));
    await expect(fetchXAccountCapabilities("token")).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
