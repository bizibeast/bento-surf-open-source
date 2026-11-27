import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: true,
  middleware: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: "owner-auth" }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const fn = {
      middleware: (middleware: unknown) => {
        mocks.middleware(middleware);
        return fn;
      },
      validator: (validator: typeof validate) => {
        validate = validator;
        return fn;
      },
      handler: (handler: (input: unknown) => unknown) => async (input?: { data: unknown }) => {
        if (!mocks.authenticated) throw new Error("Unauthorized");
        return handler({
          data: validate(input?.data),
          context: {
            userId: "selected-owned-workspace",
            authUserId: "login-user",
            supabase: { from: mocks.from },
          },
        });
      },
    };
    return fn;
  },
}));

import { getMyCommerceCurrency, setMyCommerceCurrency } from "./commerce-currency.functions";

beforeEach(() => {
  mocks.authenticated = true;
  mocks.from.mockClear();
  mocks.update.mockClear();
  mocks.select.mockClear();
  mocks.eq.mockClear();
  const query = {
    update: mocks.update,
    select: mocks.select,
    eq: mocks.eq,
    single: mocks.single,
  };
  mocks.from.mockReturnValue(query);
  mocks.update.mockReturnValue(query);
  mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query);
  mocks.single.mockResolvedValue({ data: { commerce_default_currency: "inr" }, error: null });
});

describe("saved Store currency", () => {
  it("reads the selected owned workspace's saved currency", async () => {
    expect(await getMyCommerceCurrency()).toEqual({ currency: "inr" });
    expect(mocks.middleware).toHaveBeenCalledWith(["owner-auth"]);
    expect(mocks.select).toHaveBeenCalledWith("commerce_default_currency");
    expect(mocks.eq).toHaveBeenCalledWith("id", "selected-owned-workspace");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("saves only the currency field and reads the persisted result", async () => {
    expect(await setMyCommerceCurrency({ data: { currency: "inr" } })).toEqual({ currency: "inr" });
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("profiles");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ commerce_default_currency: "inr" });
    expect(mocks.eq).toHaveBeenCalledExactlyOnceWith("id", "selected-owned-workspace");
    mocks.update.mockClear();
    expect(await getMyCommerceCurrency()).toEqual({ currency: "inr" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["jpy", "USD", "", null, 100])(
    "rejects unsupported currency %s before database access",
    async (currency) => {
      await expect(setMyCommerceCurrency({ data: { currency } } as never)).rejects.toThrow();
      expect(mocks.from).not.toHaveBeenCalled();
    },
  );

  it("rejects a caller-supplied workspace", async () => {
    await expect(
      setMyCommerceCurrency({ data: { currency: "eur", userId: "another-owner" } } as never),
    ).rejects.toThrow();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires authentication for reads and writes", async () => {
    mocks.authenticated = false;
    await expect(getMyCommerceCurrency()).rejects.toThrow("Unauthorized");
    await expect(setMyCommerceCurrency({ data: { currency: "usd" } })).rejects.toThrow(
      "Unauthorized",
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not report a successful save when RLS prevents finding the profile", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: "Not found" } });
    await expect(setMyCommerceCurrency({ data: { currency: "usd" } })).rejects.toThrow(
      "could not be saved",
    );
    await expect(getMyCommerceCurrency()).rejects.toThrow("could not be loaded");
  });
});
