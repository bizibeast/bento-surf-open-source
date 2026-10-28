import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicCommerceProduct: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { loader: unknown }) => ({ options }),
  notFound: () => {
    const error = new Error("not found");
    error.name = "NotFoundError";
    throw error;
  },
  redirect: (options: unknown) => {
    throw Object.assign(new Error("redirect"), { options });
  },
}));

vi.mock("@/lib/commerce.functions", () => ({
  getPublicCommerceProduct: mocks.getPublicCommerceProduct,
}));

import { legacyDemoProductPath, Route } from "./p.$productSlug";

const loader = (
  Route as unknown as {
    options: {
      loader: (ctx: {
        params: { productSlug: string };
        location: { searchStr: string };
      }) => Promise<unknown>;
    };
  }
).options.loader;

describe("legacy demo product paths", () => {
  it("maps only the retired demo slugs", () => {
    expect(legacyDemoProductPath("creator-launch-kit")).toBe("/features/digital-products");
    expect(legacyDemoProductPath("members-studio")).toBe("/features/memberships");
    expect(legacyDemoProductPath("audience-to-income")).toBe("/features/online-courses");
    expect(legacyDemoProductPath("creator-strategy-call")).toBe("/features/coaching-and-bookings");
    expect(legacyDemoProductPath("creator-community")).toBe("/features/paid-communities");
    expect(legacyDemoProductPath("real-product")).toBeNull();
  });

  it("keeps a real product redirect ahead of the demo map", async () => {
    mocks.getPublicCommerceProduct.mockResolvedValue({
      creator: { username: "ada" },
      product: { public_slug: "creator-launch-kit" },
    });

    await expect(
      loader({
        params: { productSlug: "creator-launch-kit" },
        location: { searchStr: "?ref=home" },
      }),
    ).rejects.toMatchObject({
      options: { href: "/@ada/products/creator-launch-kit?ref=home", statusCode: 308 },
    });
  });

  it("301s a demo slug only after the product lookup misses", async () => {
    mocks.getPublicCommerceProduct.mockResolvedValue(null);

    await expect(
      loader({ params: { productSlug: "members-studio" }, location: { searchStr: "" } }),
    ).rejects.toMatchObject({
      options: { href: "/features/memberships", statusCode: 301 },
    });
    await expect(
      loader({ params: { productSlug: "unknown-product" }, location: { searchStr: "" } }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
