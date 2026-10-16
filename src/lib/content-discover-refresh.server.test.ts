import { afterEach, expect, it, vi } from "vitest";
import {
  withDiscoverRefreshLease,
  type DiscoverRefreshDependencies,
} from "./content-discover-refresh.server";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("prevents a timeout retry from starting duplicate work while another user can refresh", async () => {
  const leases = new Map<string, string>();
  const rpc = vi.fn<DiscoverRefreshDependencies["db"]["rpc"]>(async (name, input) => {
    if (name === "claim_discover_refresh") {
      if (leases.has(input.p_user_id)) return { data: null, error: null };
      leases.set(input.p_user_id, `lease-${input.p_user_id}`);
      return { data: leases.get(input.p_user_id), error: null };
    }
    if (name === "release_discover_refresh") leases.delete(input.p_user_id);
    return { data: true, error: null };
  });
  const dependencies = { db: { rpc } };
  const entered = deferred();
  const finish = deferred();
  const first = withDiscoverRefreshLease(
    "first",
    async ({ assertCurrent }) => {
      entered.resolve();
      await finish.promise;
      await assertCurrent();
      return "first result";
    },
    dependencies,
  );
  await entered.promise;

  const duplicateWork = vi.fn();
  await expect(withDiscoverRefreshLease("first", duplicateWork, dependencies)).rejects.toThrow(
    "Discover refresh is already running. Retrying shortly.",
  );
  expect(duplicateWork).not.toHaveBeenCalled();
  await expect(
    withDiscoverRefreshLease("second", async () => "independent", dependencies),
  ).resolves.toBe("independent");
  finish.resolve();
  await expect(first).resolves.toBe("first result");
  await expect(withDiscoverRefreshLease("first", async () => "retry", dependencies)).resolves.toBe(
    "retry",
  );
});

it("releases precisely the acquired user/token when a provider fails", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: "own-token", error: null });
  await expect(
    withDiscoverRefreshLease(
      "creator",
      async () => {
        throw new Error("provider timed out");
      },
      { db: { rpc } },
    ),
  ).rejects.toThrow("provider timed out");
  expect(rpc).toHaveBeenLastCalledWith("release_discover_refresh", {
    p_user_id: "creator",
    p_lease_key: "own-token",
  });
});

it("fences a late worker before persistence after its lease expires or is replaced", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: "expired-token", error: null })
    .mockResolvedValueOnce({ data: false, error: null })
    .mockResolvedValueOnce({ data: null, error: null });
  const save = vi.fn();
  await expect(
    withDiscoverRefreshLease(
      "creator",
      async ({ assertCurrent }) => {
        await assertCurrent();
        return save();
      },
      { db: { rpc } },
    ),
  ).rejects.toThrow("Discover refresh was interrupted. Retrying shortly.");
  expect(save).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenNthCalledWith(2, "is_discover_refresh_current", {
    p_user_id: "creator",
    p_lease_key: "expired-token",
  });
  expect(rpc).toHaveBeenLastCalledWith("release_discover_refresh", {
    p_user_id: "creator",
    p_lease_key: "expired-token",
  });
});

it.each(["rpc error", "network error"])("fails closed on claim %s", async (failure) => {
  const rpc =
    failure === "network error"
      ? vi.fn().mockRejectedValue(new Error("private database details"))
      : vi.fn().mockResolvedValue({ data: null, error: { message: "private database details" } });
  const work = vi.fn();
  await expect(withDiscoverRefreshLease("creator", work, { db: { rpc } })).rejects.toThrow(
    "Discover refresh could not start. Retrying shortly.",
  );
  expect(work).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});

it.each(["rpc error", "network error"])("fails closed on ownership %s", async (failure) => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: "token", error: null });
  if (failure === "network error") rpc.mockRejectedValueOnce(new Error("network"));
  else rpc.mockResolvedValueOnce({ data: null, error: { message: "database" } });
  rpc.mockResolvedValueOnce({ data: null, error: null });
  const save = vi.fn();
  await expect(
    withDiscoverRefreshLease(
      "creator",
      async ({ assertCurrent }) => {
        await assertCurrent();
        save();
      },
      { db: { rpc } },
    ),
  ).rejects.toThrow("Discover refresh was interrupted. Retrying shortly.");
  expect(save).not.toHaveBeenCalled();
});

it.each(["rpc error", "network error"])(
  "preserves successful work when release has a %s",
  async (failure) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValueOnce({ data: "token", error: null });
    if (failure === "network error") rpc.mockRejectedValueOnce(new Error("network"));
    else rpc.mockResolvedValueOnce({ data: null, error: { message: "database" } });
    await expect(
      withDiscoverRefreshLease("creator", async () => "saved", { db: { rpc } }),
    ).resolves.toBe("saved");
    expect(warning).toHaveBeenCalledWith("[Discover] Refresh lease release deferred.");
  },
);

it("does not replace the provider error when releasing also fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: "token", error: null })
    .mockRejectedValueOnce(new Error("release failed"));
  await expect(
    withDiscoverRefreshLease(
      "creator",
      async () => {
        throw new Error("provider timeout");
      },
      { db: { rpc } },
    ),
  ).rejects.toThrow("provider timeout");
});
