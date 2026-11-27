import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), enqueue: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./email.server", () => ({ enqueueCommerceOrderEmails: mocks.enqueue }));
vi.mock("./secret-crypto.server", () => ({ decryptServerSecret: mocks.decrypt }));
import {
  finalizeCommerceFulfillment,
  reconcileCommerceFulfillment,
} from "./commerce-fulfillment.server";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let failNextSessionUpdate: boolean;
const sessionId = "d32b537f-e1fa-47e8-9e9a-258b1b8bfeb9";

// Execute the query operations against rows rather than returning canned query
// results, so a missing immutable-ID lookup remains an observable regression.
function query(table: string) {
  const predicates: Array<(row: Row) => boolean> = [];
  let patch: Row | undefined;
  let maximum = Infinity;
  let invalidUuidQuery = false;
  const valueAt = (row: Row, field: string) => {
    if (field === "metadata->>bento_session_id") {
      return (row.metadata as Row | null)?.bento_session_id;
    }
    return row[field];
  };
  const execute = async () => {
    if (invalidUuidQuery)
      return { data: null, error: { message: "invalid input syntax for type uuid" } };
    if (patch && table === "commerce_payment_sessions" && failNextSessionUpdate) {
      failNextSessionUpdate = false;
      return { data: null, error: { message: "session update interrupted" } };
    }
    const rows = (tables[table] || [])
      .filter((row) => predicates.every((predicate) => predicate(row)))
      .slice(0, maximum);
    if (patch) rows.forEach((row) => Object.assign(row, patch));
    return { data: rows, error: null };
  };
  const builder = {
    select: vi.fn(() => builder),
    update: vi.fn((value: Row) => {
      patch = value;
      return builder;
    }),
    eq: vi.fn((field: string, value: unknown) => {
      predicates.push((row) => valueAt(row, field) === value);
      return builder;
    }),
    neq: vi.fn((field: string, value: unknown) => {
      predicates.push((row) => valueAt(row, field) !== value);
      return builder;
    }),
    in: vi.fn((field: string, values: unknown[]) => {
      if (
        table === "commerce_payment_sessions" &&
        field === "id" &&
        values.some((value) => typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value))
      )
        invalidUuidQuery = true;
      predicates.push((row) => values.includes(valueAt(row, field)));
      return builder;
    }),
    not: vi.fn((field: string, _operator: string, value: unknown) => {
      predicates.push((row) => valueAt(row, field) !== value);
      return builder;
    }),
    order: vi.fn(() => builder),
    limit: vi.fn((value: number) => {
      maximum = value;
      return builder;
    }),
    maybeSingle: vi.fn(async () => {
      const result = await execute();
      return { ...result, data: result.data?.[0] || null };
    }),
    then: (resolve: (result: unknown) => unknown) => execute().then(resolve),
  };
  return builder;
}

function session(overrides: Row = {}) {
  return {
    id: sessionId,
    provider: "paypal",
    product_id: "product",
    creator_id: "creator",
    provider_checkout_id: "I-SUBSCRIPTION",
    status: "pending",
    metadata: { access_token_ciphertext: "encrypted-original" },
    ...overrides,
  };
}
function order(overrides: Row = {}) {
  return {
    id: "order",
    provider: "paypal",
    product_id: "product",
    creator_id: "creator",
    status: "paid",
    provider_checkout_id: "paypal:subscription-payment:SALE-1",
    metadata: { bento_session_id: sessionId },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  failNextSessionUpdate = false;
  tables = {
    commerce_payment_sessions: [session()],
    commerce_orders: [order()],
    commerce_products: [{ id: "product", kind: "membership" }],
    commerce_priority_dm_messages: [],
    email_outbox: [],
  };
  mocks.from.mockImplementation(query);
  mocks.decrypt.mockImplementation(async (ciphertext: string) => `decrypted:${ciphertext}`);
  mocks.enqueue.mockResolvedValue(undefined);
});

describe("commerce fulfillment reconciliation across recurring payment identifiers", () => {
  it("repairs an interrupted recurring finalization using the immutable session binding and original access token", async () => {
    failNextSessionUpdate = true;
    await expect(
      finalizeCommerceFulfillment({
        session: tables.commerce_payment_sessions[0] as ReturnType<typeof session>,
        orderId: "order",
        providerCheckoutId: "I-SUBSCRIPTION",
      }),
    ).rejects.toThrow("session update interrupted");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(await reconcileCommerceFulfillment()).toEqual({
      reconciledSessions: 1,
      repairedOrders: 1,
      failedOrders: 0,
    });
    expect(tables.commerce_payment_sessions[0]).toMatchObject({
      status: "paid",
      provider_checkout_id: "I-SUBSCRIPTION",
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      orderId: "order",
      accessToken: "decrypted:encrypted-original",
    });
  });

  it("repairs renewal emails from the original paid session despite a distinct transaction checkout ID", async () => {
    tables.commerce_payment_sessions[0].status = "paid";
    tables.commerce_orders = [
      order({ id: "renewal", provider_checkout_id: "paypal:subscription-payment:SALE-2" }),
    ];
    expect(await reconcileCommerceFulfillment()).toEqual({
      reconciledSessions: 0,
      repairedOrders: 1,
      failedOrders: 0,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      orderId: "renewal",
      accessToken: "decrypted:encrypted-original",
    });
  });

  it.each([
    { provider: "stripe" },
    { product_id: "another-product" },
    { creator_id: "another-creator" },
  ])(
    "does not update a session or disclose its token for a conflicting order scope %j",
    async (scope) => {
      tables.commerce_orders = [order(scope)];
      expect(await reconcileCommerceFulfillment()).toEqual({
        reconciledSessions: 0,
        repairedOrders: 1,
        failedOrders: 0,
      });
      expect(tables.commerce_payment_sessions[0].status).toBe("pending");
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.enqueue).toHaveBeenCalledWith({ orderId: "order", accessToken: null });
    },
  );

  it("does not fall back to another checkout's token when immutable metadata names a missing session", async () => {
    tables.commerce_orders = [
      order({
        provider_checkout_id: "I-SUBSCRIPTION",
        metadata: { bento_session_id: "291bf43a-1f1e-478f-8ced-d5b8a18ec870" },
      }),
    ];
    expect(await reconcileCommerceFulfillment()).toEqual({
      reconciledSessions: 0,
      repairedOrders: 1,
      failedOrders: 0,
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith({ orderId: "order", accessToken: null });
  });

  it("ignores malformed immutable IDs without falling back to another session or breaking UUID queries", async () => {
    tables.commerce_orders = [
      order({
        provider_checkout_id: "I-SUBSCRIPTION",
        metadata: { bento_session_id: "not-a-uuid" },
      }),
    ];
    expect(await reconcileCommerceFulfillment()).toEqual({
      reconciledSessions: 0,
      repairedOrders: 1,
      failedOrders: 0,
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith({ orderId: "order", accessToken: null });
  });

  it("preserves one-time checkout matching when historical orders have no session metadata", async () => {
    tables.commerce_orders = [order({ provider_checkout_id: "I-SUBSCRIPTION", metadata: {} })];
    expect(await reconcileCommerceFulfillment()).toEqual({
      reconciledSessions: 1,
      repairedOrders: 1,
      failedOrders: 0,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      orderId: "order",
      accessToken: "decrypted:encrypted-original",
    });
  });

  it("repairs a paid recurring session even if the original checkout identifier was not persisted", async () => {
    tables.commerce_payment_sessions[0].provider_checkout_id = null;
    expect(await reconcileCommerceFulfillment()).toEqual({
      reconciledSessions: 1,
      repairedOrders: 1,
      failedOrders: 0,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      orderId: "order",
      accessToken: "decrypted:encrypted-original",
    });
  });
});
