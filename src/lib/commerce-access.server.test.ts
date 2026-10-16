import { describe, expect, it, vi } from "vitest";
import {
  commerceTokenHash,
  plausibleCommerceToken,
  randomCommerceToken,
  resolveCommerceGrantByToken,
} from "./commerce-access.server";

vi.mock("./billing-public.server", () => ({
  isWorkspacePublicBillingAvailable: vi.fn(async () => true),
}));

type Row = Record<string, unknown>;

function mockClient(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let projection = "*";
      const query = {
        select(columns = "*") {
          projection = columns;
          return query;
        },
        eq(field: string, value: unknown) {
          filters.push(["eq", field, value]);
          return query;
        },
        gt(field: string, value: unknown) {
          filters.push(["gt", field, value]);
          return query;
        },
        async maybeSingle() {
          const rows = (tables[table] || []).filter((row) =>
            filters.every(([operator, field, value]) =>
              operator === "eq"
                ? row[field] === value
                : String(row[field] || "") > String(value || ""),
            ),
          );
          const row = rows[0];
          const data =
            row && !projection.includes("*")
              ? Object.fromEntries(
                  projection.split(",").map((key) => [key.trim(), row[key.trim()]]),
                )
              : row;
          return { data: data || null, error: null };
        },
      };
      return query;
    },
  };
}

describe("commerce access tokens", () => {
  it("generates URL-safe high-entropy tokens and deterministic hashes", async () => {
    const token = randomCommerceToken();
    expect(plausibleCommerceToken(token)).toBe(true);
    expect(token).not.toMatch(/[+/=]/);
    expect(await commerceTokenHash(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(await commerceTokenHash(token)).toBe(await commerceTokenHash(token));
    expect(randomCommerceToken()).not.toBe(token);
  });

  it("rejects malformed tokens before querying storage", async () => {
    let queried = false;
    const client = { from: () => (queried = true) };
    await expect(resolveCommerceGrantByToken(client, "../not-a-token")).resolves.toBeNull();
    expect(queried).toBe(false);
  });

  it("resolves both permanent purchase links and short-lived library capabilities", async () => {
    const permanentToken = randomCommerceToken();
    const capabilityToken = randomCommerceToken();
    const grant = {
      id: "grant-1",
      creator_id: "creator",
      token_hash: await commerceTokenHash(permanentToken),
      status: "active",
      expires_at: null,
    };
    const client = mockClient({
      commerce_access_grants: [grant],
      commerce_customer_access_tokens: [
        {
          grant_id: grant.id,
          token_hash: await commerceTokenHash(capabilityToken),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });

    await expect(resolveCommerceGrantByToken(client, permanentToken)).resolves.toMatchObject({
      id: "grant-1",
    });
    await expect(resolveCommerceGrantByToken(client, capabilityToken)).resolves.toMatchObject({
      id: "grant-1",
    });
  });

  it("does not resolve expired capabilities or expired grants", async () => {
    const capabilityToken = randomCommerceToken();
    const client = mockClient({
      commerce_access_grants: [
        {
          id: "grant-1",
          token_hash: "not-this-token",
          status: "active",
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
      commerce_customer_access_tokens: [
        {
          grant_id: "grant-1",
          token_hash: await commerceTokenHash(capabilityToken),
          expires_at: new Date(Date.now() - 1_000).toISOString(),
        },
      ],
    });

    await expect(resolveCommerceGrantByToken(client, capabilityToken)).resolves.toBeNull();
  });
});

it("enforces grant expiry even for projected product/progress lookups", async () => {
  const permanentToken = randomCommerceToken();
  const capabilityToken = randomCommerceToken();
  const client = mockClient({
    commerce_access_grants: [
      {
        id: "expired",
        product_id: "product",
        creator_id: "creator",
        status: "active",
        token_hash: await commerceTokenHash(permanentToken),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
    commerce_customer_access_tokens: [
      {
        grant_id: "expired",
        token_hash: await commerceTokenHash(capabilityToken),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  });
  for (const token of [permanentToken, capabilityToken])
    await expect(resolveCommerceGrantByToken(client, token, "id, product_id")).resolves.toBeNull();
});
