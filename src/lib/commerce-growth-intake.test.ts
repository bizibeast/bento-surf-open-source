import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  mutations: [] as Array<{ table: string; value: unknown }>,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (next: typeof validate) => {
        validate = next;
        return builder;
      },
      handler:
        (handler: (input: { data: unknown; context: { userId: string } }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data), context: { userId: "creator" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn().mockResolvedValue("creator"),
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./email.server", () => ({
  enqueueEmailBatch: vi.fn(),
  getCreatorEmailCapacity: vi.fn(),
  recordEmailMarketingCapacityBlock: vi.fn(),
  scheduleAudienceCampaignForCreator: vi.fn(),
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
import { resolveCommerceCheckoutGrowth } from "./commerce-growth.server";
import { saveCommerceOrderBump } from "./commerce-growth.functions";

const primaryId = "a0ebf493-8938-4f41-b64b-eb82ec5872ac";
const bumpId = "d15cc29b-cdf8-4ba0-b8c6-af655c9d53cc";
const questionId = "b03eb0aa-a8fb-4800-bf72-8b854c680385";
type Row = Record<string, unknown>;
let products: Row[];
function sectionSettings(required: boolean) {
  return {
    website: {
      sections: [
        {
          id: "intake",
          title: "Before purchase",
          body: "",
          buyerQuestions: [{ id: questionId, question: "What is your goal?", required }],
        },
      ],
    },
  };
}
function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  let columns = "*";
  let mutation: Row | undefined;
  const execute = async () => {
    if (mutation) {
      mocks.mutations.push({ table, value: mutation });
      return { data: { id: "saved", ...mutation }, error: null };
    }
    const rows =
      table === "commerce_products"
        ? products
        : table === "commerce_order_bumps"
          ? [
              {
                id: "rule",
                creator_id: "creator",
                primary_product_id: primaryId,
                bump_product_id: bumpId,
                is_active: true,
              },
            ]
          : [{ id: "creator", commerce_payment_provider: "stripe" }];
    const matched = rows.find((row) => filters.every(([key, value]) => row[key] === value));
    const data =
      matched && columns !== "*"
        ? Object.fromEntries(
            columns
              .split(",")
              .map((field) => field.trim())
              .map((key) => [key, matched[key]]),
          )
        : matched || null;
    return { data, error: null };
  };
  const builder = {
    select: (fields: string) => {
      columns = fields;
      return builder;
    },
    eq: (key: string, value: unknown) => {
      filters.push([key, value]);
      return builder;
    },
    insert: (value: Row) => {
      mutation = value;
      return builder;
    },
    update: (value: Row) => {
      mutation = value;
      return builder;
    },
    maybeSingle: execute,
    single: execute,
  };
  return builder;
}
const primary = {
  id: primaryId,
  creator_id: "creator",
  kind: "course",
  status: "published",
  pricing_type: "one_time" as const,
  price_amount: 2000,
  currency: "usd",
  inventory_limit: null,
  sales_count: 0,
  settings: {},
};
const bumpInput = {
  primaryProductId: primaryId,
  bumpProductId: bumpId,
  headline: "Add this",
  description: "Extra",
  isActive: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutations.length = 0;
  products = [
    primary,
    {
      ...primary,
      id: bumpId,
      title: "Extra course",
      price_amount: 500,
      settings: sectionSettings(true),
    },
  ];
  mocks.from.mockImplementation(query);
});

describe("secondary offer buyer-intake boundaries", () => {
  it("rejects checkout selection when the selected bump requires an answer absent from the primary checkout", async () => {
    await expect(
      resolveCommerceCheckoutGrowth({
        product: primary,
        provider: "stripe",
        bumpProductId: bumpId,
      }),
    ).rejects.toThrow(/required buyer questions|purchased separately/i);
    expect(mocks.mutations).toEqual([]);
  });
  it("rejects activating an order bump with required buyer questions", async () => {
    await expect(saveCommerceOrderBump({ data: bumpInput })).rejects.toThrow(
      /required buyer questions|purchased separately/i,
    );
    expect(mocks.mutations).toEqual([]);
  });
  it("allows optional-only section questions without changing established bump pricing", async () => {
    products[1].settings = sectionSettings(false);
    const quote = await resolveCommerceCheckoutGrowth({
      product: primary,
      provider: "paypal",
      bumpProductId: bumpId,
    });
    expect(quote).toMatchObject({
      primaryAmount: 2000,
      bumpAmount: 500,
      grossAmount: 2500,
      bumpProductId: bumpId,
    });
    await expect(saveCommerceOrderBump({ data: bumpInput })).resolves.toMatchObject({
      is_active: true,
    });
  });
  it("allows deactivating an existing bump after its target gains required intake", async () => {
    await expect(
      saveCommerceOrderBump({ data: { ...bumpInput, isActive: false } }),
    ).resolves.toMatchObject({ is_active: false });
    expect(mocks.mutations).toHaveLength(1);
  });
  it("rejects legacy required custom-product intake as a selected bump", async () => {
    products[1].kind = "custom_product";
    products[1].settings = { buyerQuestions: ["What do you need?"] };
    await expect(
      resolveCommerceCheckoutGrowth({
        product: primary,
        provider: "stripe",
        bumpProductId: bumpId,
      }),
    ).rejects.toThrow(/required buyer questions|purchased separately/i);
  });
  it("rejects the implicit required priority message even without extra custom questions", async () => {
    products[1].kind = "priority_dm";
    products[1].settings = {};
    await expect(
      resolveCommerceCheckoutGrowth({
        product: primary,
        provider: "stripe",
        bumpProductId: bumpId,
      }),
    ).rejects.toThrow(/priority|purchased separately/i);
  });
  it("rechecks current target settings if required intake is added after activation", async () => {
    products[1].settings = sectionSettings(false);
    await saveCommerceOrderBump({ data: bumpInput });
    products[1].settings = sectionSettings(true);
    await expect(
      resolveCommerceCheckoutGrowth({
        product: primary,
        provider: "stripe",
        bumpProductId: bumpId,
      }),
    ).rejects.toThrow(/required buyer questions|purchased separately/i);
  });
});
