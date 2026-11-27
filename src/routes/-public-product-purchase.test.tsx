import type { ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commerceBuyerQuestions,
  commerceBuyerQuestionsVersion,
} from "@/lib/commerce-buyer-questions";

const mocks = vi.hoisted(() => ({
  loaderData: undefined as unknown,
  checkout: vi.fn(),
  tools: new Map<string, { execute: () => unknown }>(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => ({
    ...options,
    useLoaderData: () => mocks.loaderData,
    useSearch: () => ({}),
  }),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/commerce.functions", () => ({
  createCommerceCheckout: mocks.checkout,
  getCommerceAccess: vi.fn(),
  getPublicCommerceProduct: vi.fn(),
  previewCommerceCheckout: vi.fn(),
  recordCommerceAffiliateClick: vi.fn(),
  submitCommerceLead: vi.fn(),
}));
vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/webmcp", () => ({
  useWebMcpTools: (tools: Array<{ name: string; execute: () => unknown }>) => {
    for (const tool of tools) mocks.tools.set(tool.name, tool);
  },
  webMcpResult: (message: string, data: unknown) => ({ message, data }),
  requireWebMcpUserConfirmation: vi.fn(),
}));
import { Route } from "./$username_.products.$productSlug";

const requiredId = "7174f1ae-a2d9-49fc-8400-6396c19bd853";
const optionalId = "45812544-bafc-4ada-8eab-ffec2b50bcbc";
const privateSentinel = "private-buyer-answer-not-public";
function productData() {
  return {
    creator: { username: "studio", display_name: "Studio", theme: "light", accent_color: "blue" },
    chrome: {
      creator: {
        username: "studio",
        display_name: "Studio",
        theme: "dark",
        accent_color: "rose",
        primary_font: "Manrope",
        secondary_font: "Lora",
        pattern: "none",
      },
      pages: [],
      customDomain: null,
    },
    product: {
      id: "4e031f2e-dc56-4532-a1d8-31cbe0e6158b",
      creator_id: "e3ede060-82c4-4af5-9eae-1ccf1f8fa352",
      kind: "course",
      status: "published",
      slug: "studio-course",
      public_slug: "studio-course",
      title: "Build your studio",
      subtitle: "A practical course",
      description: "Learn to launch a studio.",
      cover_url: null,
      pricing_type: "one_time",
      price_amount: 1900,
      currency: "usd",
      billing_interval: null,
      cta_label: "Buy course",
      inventory_limit: null,
      sales_count: 0,
      private_internal_note: privateSentinel,
      settings: {
        private_customer_answers: privateSentinel,
        website: {
          brand: "Studio",
          accent: "#00ff00",
          background: "white",
          font: "sans",
          layout: "split",
          sections: [
            {
              id: "intake",
              title: "Before you start",
              body: "Tell us about your studio.",
              buyerQuestions: [
                {
                  id: requiredId,
                  question: "What will you launch?",
                  required: true,
                  privateSubmittedAnswer: privateSentinel,
                },
                { id: optionalId, question: "Anything else to share?", required: false },
              ],
            },
          ],
        },
      },
    },
    lessons: [],
    bundleProducts: [],
    orderBump: null,
    availabilityError: null,
    recordingAddonReady: false,
    testCheckout: false,
  };
}
const Page = (Route as unknown as { component: ComponentType }).component;
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerenderPage: () => view.rerender(tree()) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tools.clear();
  window.sessionStorage.clear();
  mocks.loaderData = productData();
  // Keep this UI integration test inside the app: an invalid fake destination
  // is rejected by the route's real destination guard before any navigation.
  mocks.checkout.mockResolvedValue({ url: "javascript:fixture", test: true });
});
afterEach(() => {
  document.querySelectorAll('link[id^="gf-"]').forEach((link) => link.remove());
});

describe("rendered public product purchase", () => {
  it("inherits the creator's current dark Link palette and fonts instead of stale standalone website overrides", () => {
    const { container } = mount();
    const root = container.querySelector<HTMLElement>("[data-product-website]")!;
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(root).toHaveClass("dark");
    expect(root.style.getPropertyValue("--background")).toBe(
      "color-mix(in oklab, #f43f5e 14%, #0b0b14)",
    );
    expect(root.style.getPropertyValue("--product-accent")).toBe("#f43f5e");
    expect(root.style.getPropertyValue("--font-sans")).toContain('"Manrope"');
    expect(root.style.getPropertyValue("--font-display")).toContain('"Lora"');
    expect(document.getElementById("gf-Manrope")).not.toBeNull();
    expect(document.getElementById("gf-Lora")).not.toBeNull();
    expect(root.getAttribute("style")).not.toContain("#00ff00");
    expect(screen.getByRole("heading", { name: "Build your studio" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Buy course" }).style.background).toBe(
      "var(--product-accent)",
    );
  });

  it("renders required and optional custom-section buyer questions for an ordinary course and blocks empty required answers", async () => {
    const user = userEvent.setup();
    mount();
    const required = screen.getByRole("textbox", { name: /What will you launch/ });
    const optional = screen.getByRole("textbox", { name: /Anything else to share/ });
    expect(required).toBeRequired();
    expect(optional).not.toBeRequired();
    expect(required).toHaveAttribute("name", `bq_${requiredId}`);
    expect(optional).toHaveAttribute("name", `bq_${optionalId}`);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "buyer@example.com" },
    });
    await user.click(screen.getByRole("button", { name: "Buy course" }));
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(required).toBeInvalid();
  });

  it("passes stable question IDs, optional answers and the current question version to the canonical checkout mutation", async () => {
    const user = userEvent.setup();
    mount();
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "buyer@example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /What will you launch/ }), {
      target: { value: "A ceramics studio" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Anything else to share/ }), {
      target: { value: "Starting in spring" },
    });
    await user.click(screen.getByRole("button", { name: "Buy course" }));
    const data = productData();
    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({
        data: expect.objectContaining({
          productId: data.product.id,
          email: "buyer@example.com",
          answers: {
            [`bq_${requiredId}`]: "A ceramics studio",
            [`bq_${optionalId}`]: "Starting in spring",
          },
          buyerQuestionsVersion: commerceBuyerQuestionsVersion(
            commerceBuyerQuestions(data.product.settings, "course"),
          ),
        }),
      }),
    );
  });

  it("exposes only public question definitions in WebMCP and never renders unknown private metadata or prior buyer answers", async () => {
    const { container } = mount();
    expect(container.innerHTML).not.toContain(privateSentinel);
    const tool = mocks.tools.get("bento_get_public_product")!;
    const result = await tool.execute();
    expect(JSON.stringify(result)).not.toContain(privateSentinel);
    expect(result).toMatchObject({
      data: {
        product: {
          buyerQuestions: [
            {
              answerKey: `bq_${requiredId}`,
              question: "What will you launch?",
              required: true,
              sectionTitle: "Before you start",
            },
            {
              answerKey: `bq_${optionalId}`,
              question: "Anything else to share?",
              required: false,
              sectionTitle: "Before you start",
            },
          ],
        },
      },
    });
  });

  it("clears the previous product's private answers when navigating to another product in the same mounted route", async () => {
    const user = userEvent.setup();
    const view = mount();
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "first@example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /What will you launch/ }), {
      target: { value: "First private answer" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Anything else to share/ }), {
      target: { value: "First private optional answer" },
    });
    const next = productData();
    next.product.id = "78d7c5c2-e37b-4402-b24e-581dcd7071ee";
    next.product.title = "Second course";
    mocks.loaderData = next;
    view.rerenderPage();
    expect(screen.getByRole("heading", { name: "Second course" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /What will you launch/ })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: /Anything else to share/ })).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "second@example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /What will you launch/ }), {
      target: { value: "Second answer" },
    });
    await user.click(screen.getByRole("button", { name: "Buy course" }));
    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({
        data: expect.objectContaining({
          productId: next.product.id,
          answers: { [`bq_${requiredId}`]: "Second answer" },
        }),
      }),
    );
  });
});

describe("paid newsletter checkout consent", () => {
  function newsletterData() {
    const data = productData();
    Object.assign(data.product, {
      kind: "newsletter",
      title: "Studio Notes paid newsletter",
      cta_label: "Subscribe",
      pricing_type: "subscription",
      billing_interval: "month",
      settings: {
        newsletterPublicationId: "03bc37ad-a37e-4389-9f58-fc521f8239ca",
        website: { ...data.product.settings.website, sections: [] },
      },
    });
    return data;
  }

  it("explains purchased newsletter delivery separately from optional creator marketing and leaves the marketing opt-in off", async () => {
    mocks.loaderData = newsletterData();
    const user = userEvent.setup();
    mount();
    expect(
      screen.getByText(/Buying this subscription signs you up for this newsletter’s paid emails/),
    ).toBeVisible();
    expect(screen.getByText(/Existing unsubscribe preferences still apply/)).toBeVisible();
    const extraUpdates = screen.getByRole("checkbox", {
      name: /Also email me other updates and offers/,
    });
    expect(extraUpdates).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "reader@example.com" },
    });
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({
        data: expect.objectContaining({ newsletterOptIn: false }),
      }),
    );
  });

  it("only requests additional creator updates when the newsletter buyer separately checks the optional box", async () => {
    mocks.loaderData = newsletterData();
    const user = userEvent.setup();
    mount();
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "reader@example.com" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /Also email me other updates and offers/ }),
    );
    await user.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({
        data: expect.objectContaining({ newsletterOptIn: true }),
      }),
    );
  });

  it("does not imply newsletter delivery or preselect marketing for ordinary purchases", () => {
    mount();
    expect(screen.queryByText(/Buying this subscription signs you up/)).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: /Email me updates and offers from this creator/ }),
    ).not.toBeChecked();
  });
});
