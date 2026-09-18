import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sync: vi.fn(), single: vi.fn(), getPlan: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: any) => fn,
  createServerFn: () => {
    let validate = (data: any) => data;
    const query: any = {
      update: () => query,
      eq: () => query,
      select: () => query,
      single: mocks.single,
    };
    const fn: any = {
      middleware: () => fn,
      validator: (value: any) => {
        validate = value;
        return fn;
      },
      handler: (handler: any) => (input: any) =>
        handler({
          data: validate(input?.data),
          context: { userId: "owner", supabase: { from: () => query } },
        }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./pages.functions", () => ({ setSystemPageVisibility: mocks.sync }));
vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan }));
import {
  profileUpdateSchema,
  sanitizePublicProfileBlocks,
  updateProfile,
} from "./profile.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.single.mockResolvedValue({ data: { id: "owner" }, error: null });
  mocks.getPlan.mockResolvedValue("creator");
});

it.each([true, false])("syncs store page visibility %s", async (enabled) => {
  await updateProfile({ data: { store_page_enabled: enabled } });
  expect(mocks.sync).toHaveBeenCalledWith(expect.anything(), "owner", "store", enabled);
});

it("leaves the store page alone for unrelated profile changes", async () => {
  await updateProfile({ data: { bio: "Hello" } });
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("retains the store plan gate", async () => {
  mocks.getPlan.mockResolvedValue("free");
  await expect(updateProfile({ data: { store_page_enabled: true } })).rejects.toThrow("Upgrade");
  expect(mocks.sync).not.toHaveBeenCalled();
});

describe("profileUpdateSchema", () => {
  it("preserves a creator's search-engine visibility preference", () => {
    expect(profileUpdateSchema.parse({ noindex: true })).toEqual({ noindex: true });
    expect(profileUpdateSchema.parse({ noindex: false })).toEqual({ noindex: false });
  });
});

describe("public profile block serialization", () => {
  it("strips newsletter linkage without mutating stored block content", () => {
    const stored = [
      {
        id: "capture",
        type: "email_capture",
        content: {
          title: "Join Studio Notes",
          newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
        },
      },
    ];
    expect(sanitizePublicProfileBlocks(stored as never)).toEqual([
      { id: "capture", type: "email_capture", content: { title: "Join Studio Notes" } },
    ]);
    expect(stored[0].content.newsletterPublicationId).toBe("11111111-1111-4111-8111-111111111111");
  });
});
