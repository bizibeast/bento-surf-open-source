import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthenticatedWebMcpTools } from "./webmcp-tools";

const { runRead, runWrite } = vi.hoisted(() => ({ runRead: vi.fn(), runWrite: vi.fn() }));

vi.mock("./webmcp.functions", () => ({
  runBentoWebMcpRead: runRead,
  runBentoWebMcpWrite: runWrite,
}));

describe("authenticated WebMCP tools", () => {
  beforeEach(() => {
    runRead.mockReset();
    runWrite.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes every authenticated operation with unique names", () => {
    const tools = createAuthenticatedWebMcpTools(vi.fn());
    expect(tools).toHaveLength(29);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_bento_overview",
        "manage_block",
        "manage_product",
        "create_social_post",
        "manage_calendar",
        "manage_community",
        "update_profile",
      ]),
    );
  });

  it("keeps legacy tool IDs while exposing publication-aware Email Marketing inputs", () => {
    const tools = Object.fromEntries(
      createAuthenticatedWebMcpTools(vi.fn()).map((tool) => [tool.name, tool]),
    );
    const storeSchema = tools.get_store_workspace.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    const audienceSchema = tools.manage_audience.inputSchema as {
      oneOf: Array<{
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      }>;
    };
    const audienceVariant = (action: string) =>
      audienceSchema.oneOf.find((variant) => variant.properties.action.const === action)!;

    expect(tools).toHaveProperty("get_store_workspace");
    expect(tools).toHaveProperty("manage_audience");
    expect(storeSchema.properties.publicationId).toMatchObject({ format: "uuid" });
    expect(audienceVariant("create_list").required).toContain("publicationId");
    expect(audienceVariant("save_campaign").required).toContain("publicationId");
    expect(audienceVariant("delete_list").properties.publicationId).toMatchObject({
      format: "uuid",
    });
    expect(tools.get_store_workspace.description).toContain("Posts");
    expect(tools.manage_audience.description).not.toMatch(/issue/i);
  });

  it("names the selected publication in audience write confirmation", async () => {
    const publicationId = "11111111-1111-4111-8111-111111111111";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const tool = createAuthenticatedWebMcpTools(vi.fn()).find(
      (candidate) => candidate.name === "manage_audience",
    );

    await expect(
      tool?.execute(
        { action: "create_list", publicationId, name: "Readers" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("did not approve");
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(`"publicationId": "${publicationId}"`),
    );
  });

  it("does not run a denied write", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const refresh = vi.fn();
    const tool = createAuthenticatedWebMcpTools(refresh).find(
      (candidate) => candidate.name === "manage_page",
    );
    const signal = new AbortController().signal;

    await expect(tool?.execute({ action: "create", name: "Press" }, { signal })).rejects.toThrow(
      "did not approve",
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(runWrite).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("runs an approved write exactly once", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    runWrite.mockResolvedValue({ id: "page-id" });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const tool = createAuthenticatedWebMcpTools(refresh).find(
      (candidate) => candidate.name === "manage_page",
    );
    const input = { action: "create", name: "Press" };

    await expect(
      tool?.execute(input, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ structuredContent: { result: { id: "page-id" } } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(runWrite).toHaveBeenCalledOnce();
    expect(runWrite).toHaveBeenCalledWith({
      data: { operation: "manage_page", input, confirmed: true },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh after cancellation during a write", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const controller = new AbortController();
    runWrite.mockImplementation(async () => {
      controller.abort();
      return { id: "page-id" };
    });
    const refresh = vi.fn();
    const tool = createAuthenticatedWebMcpTools(refresh).find(
      (candidate) => candidate.name === "manage_page",
    );

    await expect(
      tool?.execute({ action: "create", name: "Press" }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("advertises strict schemas matching the product, discount, calendar, and community contracts", () => {
    const tools = Object.fromEntries(
      createAuthenticatedWebMcpTools(vi.fn()).map((tool) => [tool.name, tool]),
    );
    const schema = (name: string) =>
      tools[name].inputSchema as {
        additionalProperties: boolean;
        properties: Record<string, Record<string, unknown>>;
        oneOf?: Array<{
          additionalProperties?: boolean;
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        }>;
      };

    expect(schema("manage_product")).toMatchObject({
      additionalProperties: false,
      properties: {
        action: {
          enum: ["create", "update", "set_status", "delete", "add_to_page"],
        },
        product: { type: "object", additionalProperties: false },
      },
    });
    expect(schema("manage_product").properties).not.toHaveProperty("kind");
    expect(
      (
        schema("manage_product").properties.product as {
          properties: { kind: { enum: string[] } };
        }
      ).properties.kind.enum,
    ).not.toContain("newsletter");
    expect(
      (
        schema("manage_product").properties.product as {
          properties: Record<string, Record<string, unknown>>;
        }
      ).properties.billing_interval,
    ).toMatchObject({
      type: ["string", "null"],
      enum: ["day", "week", "month", "year", null],
    });
    expect(schema("manage_product").oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ["action", "product"] }),
        expect.objectContaining({ required: ["action", "id", "product"] }),
        expect.objectContaining({ required: ["action", "id", "status"] }),
      ]),
    );

    expect(schema("manage_discount_code")).toMatchObject({
      additionalProperties: false,
      properties: {
        action: { enum: ["save", "delete"] },
        discountType: { enum: ["percent", "fixed"] },
        discountValue: { type: "number" },
        productId: { format: "uuid" },
        startsAt: { format: "date-time" },
        expiresAt: { format: "date-time" },
        maxRedemptions: { type: ["number", "null"] },
        maxRedemptionsPerEmail: { type: "number" },
      },
    });
    expect(schema("manage_discount_code").properties).not.toHaveProperty("value");

    expect(schema("manage_calendar")).toMatchObject({
      additionalProperties: false,
      properties: {
        action: {
          enum: [
            "save_availability",
            "set_public_page",
            "rename_public_page",
            "set_review_visibility",
            "set_default_connection",
            "disconnect_connection",
          ],
        },
        type: { enum: ["google", "fathom"] },
        id: { format: "uuid" },
      },
    });

    expect(schema("manage_community")).toMatchObject({
      additionalProperties: false,
      properties: {
        action: {
          enum: [
            "invite_member",
            "set_member_status",
            "update_member",
            "create_post",
            "pin_post",
            "delete_post",
            "create_comment",
            "moderate",
            "update_settings",
            "delete_community",
          ],
        },
        grantId: { format: "uuid" },
        notificationsEnabled: { type: "boolean" },
        contentId: { format: "uuid" },
        kind: { enum: ["post", "comment"] },
        reason: { type: "string" },
        resources: { type: "array" },
      },
    });
    expect(schema("manage_community").properties).not.toHaveProperty("memberId");
    expect(schema("manage_community").oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: ["action", "grantId", "role", "notificationsEnabled"],
        }),
        expect.objectContaining({
          required: ["action", "productId", "contentId", "kind", "status"],
        }),
      ]),
    );
  });

  it("keeps action branches strict while allowing their runtime-supported optional fields", () => {
    const tools = Object.fromEntries(
      createAuthenticatedWebMcpTools(vi.fn()).map((tool) => [tool.name, tool]),
    );
    const variant = (toolName: string, action: string) => {
      const oneOf = (tools[toolName].inputSchema as { oneOf: Array<Record<string, unknown>> })
        .oneOf;
      return oneOf.find(
        (candidate) =>
          (candidate.properties as Record<string, { const?: string }>).action?.const === action,
      ) as {
        additionalProperties: boolean;
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };
    };
    const accepts = (schema: ReturnType<typeof variant>, input: Record<string, unknown>) =>
      schema.required.every((key) => key in input) &&
      Object.keys(input).every((key) => key in schema.properties) &&
      Object.entries(schema.properties).every(
        ([key, property]) => !("const" in property) || input[key] === property.const,
      );

    for (const toolName of [
      "manage_page",
      "manage_block",
      "manage_product",
      "manage_discount_code",
      "manage_order_bump",
      "manage_audience",
      "manage_calendar",
      "manage_community",
      "manage_earn",
    ]) {
      const oneOf = (
        tools[toolName].inputSchema as { oneOf: Array<{ additionalProperties: boolean }> }
      ).oneOf;
      expect(oneOf.every((schema) => schema.additionalProperties === false)).toBe(true);
      expect(oneOf.length).toBeGreaterThan(1);
    }

    const createPage = variant("manage_page", "create");
    expect(createPage.additionalProperties).toBe(false);
    expect(accepts(createPage, { action: "create", name: "Press", url: null })).toBe(true);
    expect(accepts(createPage, { action: "create", name: "Press", id: crypto.randomUUID() })).toBe(
      false,
    );

    const createProduct = variant("manage_product", "create");
    expect(createProduct.properties).toHaveProperty("addToBento");
    expect(createProduct.properties).toHaveProperty("pageId");
    expect(createProduct.properties).not.toHaveProperty("status");

    const inviteMember = variant("manage_community", "invite_member");
    expect(inviteMember.properties).toHaveProperty("notificationsEnabled");
    expect(inviteMember.properties).not.toHaveProperty("body");

    expect(variant("manage_audience", "create_list").properties.name).toMatchObject({
      maxLength: 80,
    });
    expect(variant("manage_community", "create_comment").properties.body).toMatchObject({
      maxLength: 3_000,
    });
  });

  it("advertises the same bounded scalar and collection inputs as runtime validation", () => {
    const tools = Object.fromEntries(
      createAuthenticatedWebMcpTools(vi.fn()).map((tool) => [tool.name, tool.inputSchema]),
    ) as Record<string, { properties: Record<string, Record<string, unknown>> }>;

    expect(tools.list_social_posts.properties.status.enum).toEqual([
      "draft",
      "scheduled",
      "publishing",
      "published",
      "partially_failed",
      "failed",
      "cancelled",
    ]);
    expect(tools.update_profile.properties.username).toMatchObject({
      minLength: 3,
      maxLength: 24,
      pattern: "^[a-z0-9_]+$",
    });
    expect(tools.save_auto_dm_automation.properties).toMatchObject({
      name: { minLength: 1, maxLength: 80 },
      keywords: { maxItems: 20, items: { minLength: 1, maxLength: 80 } },
      mediaIds: { maxItems: 100, items: { minLength: 1, maxLength: 255 } },
      publicReplyMessages: { maxItems: 3, items: { minLength: 1, maxLength: 300 } },
      replyButtonUrl: { maxLength: 2048 },
    });
    const autoDmVariants = (
      createAuthenticatedWebMcpTools(vi.fn()).find(
        (tool) => tool.name === "save_auto_dm_automation",
      )?.inputSchema as {
        oneOf: Array<{ properties: Record<string, Record<string, unknown>> }>;
      }
    ).oneOf;
    expect(
      autoDmVariants.find((item) => item.properties.platform.const === "instagram")?.properties
        .replyMessage,
    ).toMatchObject({ maxLength: 1_000 });
    expect(
      autoDmVariants.find((item) => item.properties.platform.const === "twitter")?.properties
        .replyMessage,
    ).toMatchObject({ maxLength: 10_000 });
    expect(tools.manage_audience.properties).toMatchObject({
      name: { minLength: 1, maxLength: 120 },
      description: { maxLength: 500 },
      subject: { minLength: 1, maxLength: 180 },
      previewText: { maxLength: 240 },
      body: { minLength: 1, maxLength: 50_000 },
    });
    expect(tools.manage_calendar.properties.name).toMatchObject({ minLength: 1, maxLength: 40 });
    expect(tools.manage_community.properties).toMatchObject({
      email: { maxLength: 254 },
      name: { maxLength: 120 },
      body: { minLength: 1, maxLength: 10_000 },
      resources: { maxItems: 5 },
      welcomeMessage: { minLength: 1, maxLength: 2_000 },
      rules: { maxLength: 5_000 },
    });
    expect(tools.manage_earn.properties).toMatchObject({
      code: { minLength: 3, maxLength: 32 },
      currency: { pattern: "^[A-Za-z]{3}$" },
    });
  });
});
