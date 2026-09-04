import {
  runBentoWebMcpRead,
  runBentoWebMcpWrite,
  type BentoWebMcpReadOperation,
  type BentoWebMcpWriteOperation,
} from "./webmcp.functions";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";
import { COMMERCE_PRODUCT_KINDS } from "./commerce";
import { INSTAGRAM_DM_TRIGGER_TYPES } from "./instagram-auto-dm";
import { FACEBOOK_DM_TRIGGER_TYPES } from "./facebook-auto-dm";
import { TWITTER_DM_TRIGGER_TYPES } from "./twitter-auto-dm";
import { EXPLORE_CATEGORY_IDS } from "./explore";
import { PATTERNS } from "./patterns/registry";

type JsonProperties = Record<string, Record<string, unknown>>;
type VariantFields =
  | readonly string[]
  | {
      required: readonly string[];
      optional?: readonly string[];
      properties?: JsonProperties;
    };
type StrictVariant = {
  required: readonly string[];
  optional?: readonly string[];
  properties?: JsonProperties;
};
type ToolVariants =
  readonly Record<string, unknown>[] | { strict: true; variants: StrictVariant[] };

const isFieldList = (fields: VariantFields): fields is readonly string[] => Array.isArray(fields);
const isRawVariants = (variants: ToolVariants): variants is readonly Record<string, unknown>[] =>
  Array.isArray(variants);

const objectSchema = (
  properties: JsonProperties = {},
  required: string[] = [],
  additionalProperties = false,
) => ({ type: "object", properties, required, additionalProperties });

const string = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});
const nullableString = (description: string, extra: Record<string, unknown> = {}) => ({
  type: ["string", "null"],
  description,
  ...extra,
});
const boolean = (description: string) => ({ type: "boolean", description });
const number = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "number",
  description,
  ...extra,
});
const nullableNumber = (description: string, extra: Record<string, unknown> = {}) => ({
  type: ["number", "null"],
  description,
  ...extra,
});
const array = (description: string, items: Record<string, unknown> = {}) => ({
  type: "array",
  description,
  items,
});
const id = (description: string) => string(description, { format: "uuid" });
const nullableId = (description: string) => nullableString(description, { format: "uuid" });

const discriminatedVariants = (
  discriminator: string,
  variants: Record<string, VariantFields>,
): ToolVariants => ({
  strict: true,
  variants: Object.entries(variants).map(([value, fields]) => ({
    properties: {
      [discriminator]: { const: value },
      ...(isFieldList(fields) ? {} : fields.properties),
    },
    required: [discriminator, ...(isFieldList(fields) ? fields : fields.required)],
    optional: isFieldList(fields) ? [] : fields.optional,
  })),
});

const strictVariants = (variants: StrictVariant[]): ToolVariants => ({ strict: true, variants });

function variantSchemas(
  properties: JsonProperties,
  required: readonly string[],
  variants: ToolVariants,
) {
  if (isRawVariants(variants)) return variants;
  return variants.variants.map((variant) => {
    const overrides = variant.properties || {};
    const allowed = [
      ...new Set([
        ...required,
        ...variant.required,
        ...(variant.optional || []),
        ...Object.keys(overrides),
      ]),
    ];
    return objectSchema(
      Object.fromEntries(
        allowed.map((key) => [key, { ...properties[key], ...(overrides[key] || {}) }]),
      ),
      [...new Set([...required, ...variant.required])],
    );
  });
}

function readTool(
  name: string,
  title: string,
  description: string,
  operation: BentoWebMcpReadOperation,
  inputSchema = objectSchema(),
): WebMcpTool {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input, { signal }) {
      signal?.throwIfAborted();
      const result = await runBentoWebMcpRead({ data: { operation, input } });
      signal?.throwIfAborted();
      return webMcpResult(`${title} loaded.`, { result });
    },
  };
}

function writeTool(
  name: string,
  title: string,
  description: string,
  operation: BentoWebMcpWriteOperation,
  properties: JsonProperties,
  required: string[],
  refresh: () => Promise<void>,
  variants: ToolVariants = [],
): WebMcpTool {
  const oneOf = variantSchemas(properties, required, variants);
  return {
    name,
    title,
    description: `${description} Bento shows a browser approval dialog before applying this change.`,
    inputSchema: {
      ...objectSchema(properties, required),
      ...(oneOf.length ? { oneOf } : {}),
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input, { signal }) {
      signal?.throwIfAborted();
      await requireWebMcpUserConfirmation(title, input);
      signal?.throwIfAborted();
      const result = await runBentoWebMcpWrite({
        data: { operation, input, confirmed: true },
      });
      signal?.throwIfAborted();
      await refresh();
      signal?.throwIfAborted();
      return webMcpResult(`${title} completed.`, { result });
    },
  };
}

export function createAuthenticatedWebMcpTools(refresh: () => Promise<void>): WebMcpTool[] {
  const platform = string("Social platform.", {
    enum: ["instagram", "facebook", "twitter", "linkedin", "tiktok", "youtube", "threads"],
  });
  const autoDmPlatform = string("Auto-DM platform.", {
    enum: ["instagram", "facebook", "twitter"],
  });
  const product = objectSchema(
    {
      kind: string("Product kind.", {
        enum: COMMERCE_PRODUCT_KINDS.filter((kind) => kind !== "newsletter"),
      }),
      title: string("Product title.", { minLength: 1, maxLength: 120 }),
      subtitle: string("Product subtitle.", { maxLength: 180 }),
      description: string("Product description.", { maxLength: 20_000 }),
      cover_url: nullableString("Optional public cover URL.", { maxLength: 2_048 }),
      pricing_type: string("Pricing type.", {
        enum: ["free", "one_time", "subscription"],
      }),
      price_amount: number("Price in minor units.", {
        minimum: 0,
        maximum: 100_000_000,
        multipleOf: 1,
      }),
      currency: string("Three-letter lowercase currency code.", {
        pattern: "^[a-z]{3}$",
      }),
      billing_interval: nullableString("Subscription billing interval.", {
        enum: ["day", "week", "month", "year", null],
      }),
      cta_label: string("Product call-to-action label.", {
        minLength: 1,
        maxLength: 40,
      }),
      settings: {
        type: "object",
        description: "Kind-specific product settings.",
        additionalProperties: true,
      },
      inventory_limit: nullableNumber("Optional inventory limit.", {
        minimum: 1,
        maximum: 1_000_000,
        multipleOf: 1,
      }),
      noindex: boolean("Whether search engines should avoid indexing this product."),
    },
    ["kind", "title", "pricing_type", "price_amount", "cta_label"],
  );
  const weeklyRule = objectSchema(
    {
      day: number("Weekday from Sunday (0) through Saturday (6).", {
        minimum: 0,
        maximum: 6,
        multipleOf: 1,
      }),
      start: string("Start time in HH:MM format.", {
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
      }),
      end: string("End time in HH:MM format.", {
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
      }),
    },
    ["day", "start", "end"],
  );
  const timeRange = objectSchema(
    {
      start: string("Start time in HH:MM format.", {
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
      }),
      end: string("End time in HH:MM format.", {
        pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
      }),
    },
    ["start", "end"],
  );
  const availability = objectSchema(
    {
      timezone: string("IANA timezone.", { minLength: 1, maxLength: 100 }),
      weeklyRules: array("Weekly availability rules.", weeklyRule),
      dateOverrides: array(
        "Date-specific availability overrides.",
        objectSchema(
          {
            date: string("Date in YYYY-MM-DD format.", {
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            }),
            unavailable: boolean("Whether the whole date is unavailable."),
            ranges: array("Available time ranges for this date.", timeRange),
          },
          ["date"],
        ),
      ),
      minimumNoticeMinutes: number("Minimum booking notice in minutes.", {
        minimum: 0,
        maximum: 525_600,
        multipleOf: 1,
      }),
      maximumDaysAhead: number("Maximum days visitors can book ahead.", {
        minimum: 1,
        maximum: 365,
        multipleOf: 1,
      }),
      bufferBeforeMinutes: number("Buffer before a booking.", {
        minimum: 0,
        maximum: 480,
        multipleOf: 1,
      }),
      bufferAfterMinutes: number("Buffer after a booking.", {
        minimum: 0,
        maximum: 480,
        multipleOf: 1,
      }),
      slotIntervalMinutes: number("Booking slot interval.", {
        minimum: 5,
        maximum: 240,
        multipleOf: 1,
      }),
    },
    [
      "timezone",
      "weeklyRules",
      "minimumNoticeMinutes",
      "maximumDaysAhead",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "slotIntervalMinutes",
    ],
  );

  return [
    readTool(
      "get_bento_overview",
      "Bento overview",
      "Loads the signed-in creator profile, workspace counts, connection counts, and feature links.",
      "get_bento_overview",
    ),
    readTool(
      "list_social_accounts",
      "Social accounts",
      "Lists connected publishing and Auto-DM accounts with readiness and reconnect issues.",
      "list_social_accounts",
      objectSchema({ provider: platform }),
    ),
    readTool(
      "list_social_posts",
      "Social posts",
      "Lists recent drafts, scheduled posts, and publishing results.",
      "list_social_posts",
      objectSchema({
        status: string("Optional post status filter.", {
          enum: [
            "draft",
            "scheduled",
            "publishing",
            "published",
            "partially_failed",
            "failed",
            "cancelled",
          ],
        }),
        limit: number("Maximum posts to return.", { minimum: 1, maximum: 100 }),
      }),
    ),
    readTool(
      "list_auto_dm_automations",
      "Auto-DM automations",
      "Lists Instagram, Facebook, and X Auto-DM automations and account readiness.",
      "list_auto_dm_automations",
      objectSchema({ platform: autoDmPlatform }),
    ),
    readTool(
      "list_pages",
      "Bento pages and blocks",
      "Lists the creator's pages and blocks with stable IDs and current layout.",
      "list_pages",
    ),
    readTool(
      "list_products",
      "Bento products",
      "Lists products, sessions, courses, webinars, communities, and lead forms.",
      "list_products",
      objectSchema({ limit: number("Maximum products to return.", { minimum: 1, maximum: 100 }) }),
    ),
    readTool(
      "list_bookings",
      "Bento bookings",
      "Lists creator bookings and meeting state.",
      "list_bookings",
      objectSchema({ limit: number("Maximum bookings to return.", { minimum: 1, maximum: 100 }) }),
    ),
    readTool(
      "get_store_workspace",
      "Store workspace",
      "Loads products, orders, leads, contacts, discounts, order bumps, publications, Posts, audience lists, and campaigns.",
      "get_store_workspace",
      objectSchema({
        publicationId: id("Optional owned publication ID to scope Email Marketing data."),
      }),
    ),
    readTool(
      "get_calendar_workspace",
      "Calendar workspace",
      "Loads sessions, bookings, availability, public calendar state, reviews, and calendar integrations.",
      "get_calendar_workspace",
    ),
    readTool(
      "get_community_workspace",
      "Community workspace",
      "Loads communities, members, posts, and comments.",
      "get_community_workspace",
      objectSchema({ productId: id("Optional community product ID.") }),
    ),
    readTool(
      "get_profile_workspace",
      "Profile workspace",
      "Loads editable profile settings, plan limits, usage, and safe payment readiness.",
      "get_profile_workspace",
    ),
    readTool(
      "get_analytics_workspace",
      "Analytics workspace",
      "Loads page, commerce, social, and content analytics for a selected range.",
      "get_analytics_workspace",
      objectSchema({
        range: string("Analytics range.", {
          enum: ["today", "3d", "7d", "30d", "90d", "all"],
          default: "30d",
        }),
      }),
    ),
    readTool(
      "get_integration_workspace",
      "Integration workspace",
      "Loads social, calendar, meeting, and payment integration readiness without credentials.",
      "get_integration_workspace",
    ),
    readTool(
      "get_earn_workspace",
      "Earn workspace",
      "Loads referral link, clicks, attributed customers, commissions, payouts, and reach submissions.",
      "get_earn_workspace",
    ),
    writeTool(
      "upload_media",
      "Upload media to Bento",
      "Imports one public media URL or a small base64 payload into the creator's Bento media storage.",
      "upload_media",
      {
        sourceUrl: string("Public HTTP or HTTPS media URL."),
        base64: string("Optional base64 media payload up to 25 MB."),
        fileName: string("Filename including extension."),
        mimeType: string("Media MIME type."),
        kind: string("Media kind.", { enum: ["image", "video", "audio", "file"] }),
      },
      ["fileName", "mimeType", "kind"],
      refresh,
      [
        { required: ["sourceUrl"], not: { required: ["base64"] } },
        { required: ["base64"], not: { required: ["sourceUrl"] } },
      ],
    ),
    writeTool(
      "create_social_post",
      "Save social post",
      "Creates a draft, schedules a post, or publishes it through selected connected-account IDs.",
      "create_social_post",
      {
        id: id("Existing post ID when updating."),
        body: string("Post body; may be empty for supported media, title, or link posts.", {
          maxLength: 10_000,
        }),
        title: string("Optional post title.", { maxLength: 300 }),
        connectionIds: {
          ...array("Connected social account IDs.", { type: "string", format: "uuid" }),
          minItems: 1,
          maxItems: 20,
        },
        media: {
          ...array(
            "Previously uploaded Bento media items.",
            objectSchema(
              {
                key: string("Bento media storage key.", { minLength: 1, maxLength: 500 }),
                url: string("Bento media URL.", { format: "uri", maxLength: 2_000 }),
                name: string("Media filename.", { minLength: 1, maxLength: 255 }),
                mimeType: string("Media MIME type.", { minLength: 1, maxLength: 100 }),
                size: number("Media size in bytes.", {
                  minimum: 1,
                  maximum: 5 * 1024 * 1024 * 1024,
                  multipleOf: 1,
                }),
              },
              ["key", "url", "name", "mimeType", "size"],
            ),
          ),
          maxItems: 10,
        },
        providerSettings: {
          type: "object",
          description: "Per-provider post settings.",
          additionalProperties: { type: "object", additionalProperties: true },
        },
        mode: string("Save mode.", { enum: ["draft", "schedule", "publish_now"] }),
        scheduledAt: string("ISO timestamp required for schedule mode.", { format: "date-time" }),
        timezone: string("IANA timezone.", { minLength: 1, maxLength: 100 }),
      },
      ["connectionIds", "mode"],
      refresh,
      discriminatedVariants("mode", {
        draft: {
          required: [],
          optional: ["id", "body", "title", "media", "providerSettings", "timezone"],
        },
        schedule: {
          required: ["scheduledAt"],
          optional: ["id", "body", "title", "media", "providerSettings", "timezone"],
        },
        publish_now: {
          required: [],
          optional: ["id", "body", "title", "media", "providerSettings", "timezone"],
        },
      }),
    ),
    writeTool(
      "save_auto_dm_automation",
      "Save Auto-DM automation",
      "Creates or updates an Instagram, Facebook, or X Auto-DM automation.",
      "save_auto_dm_automation",
      {
        platform: autoDmPlatform,
        id: id("Existing automation ID when updating."),
        connectionId: id("Connected account ID."),
        name: string("Automation name.", { minLength: 1, maxLength: 80 }),
        triggerType: string("Platform trigger type.", {
          enum: [
            ...new Set([
              ...INSTAGRAM_DM_TRIGGER_TYPES,
              ...FACEBOOK_DM_TRIGGER_TYPES,
              ...TWITTER_DM_TRIGGER_TYPES,
            ]),
          ],
        }),
        keywords: {
          ...array("Trigger keywords.", { type: "string", minLength: 1, maxLength: 80 }),
          maxItems: 20,
        },
        excludedKeywords: {
          ...array("Excluded keywords.", { type: "string", minLength: 1, maxLength: 80 }),
          maxItems: 20,
        },
        matchType: string("Keyword matching mode.", { enum: ["contains", "exact"] }),
        mediaScope: string("Instagram or Facebook media scope.", {
          enum: ["any", "specific", "future"],
        }),
        mediaIds: {
          ...array("Instagram or Facebook media IDs.", {
            type: "string",
            minLength: 1,
            maxLength: 255,
          }),
          maxItems: 100,
        },
        replyMessage: string("DM reply message.", { minLength: 1, maxLength: 10_000 }),
        publicReplyEnabled: boolean("Whether comment triggers also receive a public reply."),
        publicReplyMessages: {
          ...array("Public reply variants.", {
            type: "string",
            minLength: 1,
            maxLength: 300,
          }),
          maxItems: 3,
        },
        openingMessage: nullableString("Optional opening message.", {
          minLength: 1,
          maxLength: 1_000,
        }),
        confirmationButtonLabel: nullableString("Optional suggested-reply label.", {
          minLength: 1,
          maxLength: 20,
        }),
        emailCaptureEnabled: boolean("Whether the flow asks for an email address."),
        emailPromptMessage: nullableString("Email capture prompt.", {
          minLength: 1,
          maxLength: 700,
        }),
        emailMarketingConsentEnabled: boolean("Whether the flow asks for marketing consent."),
        followGateEnabled: boolean("Whether Instagram comment flows verify a follow first."),
        followPromptMessage: string("Instagram follow verification prompt.", {
          minLength: 1,
          maxLength: 700,
        }),
        followMaxRechecks: number("Maximum Instagram follow rechecks.", {
          minimum: 1,
          maximum: 3,
          multipleOf: 1,
        }),
        followFailAction: string("Instagram follow-check failure action.", {
          enum: ["send_anyway", "withhold"],
        }),
        replyButtonLabel: nullableString("Optional outbound link button label.", {
          minLength: 1,
          maxLength: 20,
        }),
        replyButtonUrl: nullableString("Optional secure outbound link URL.", {
          format: "uri",
          maxLength: 2_048,
        }),
        enabled: boolean("Whether the automation should be enabled."),
      },
      ["platform"],
      refresh,
      [
        ...(
          [
            ["instagram", INSTAGRAM_DM_TRIGGER_TYPES],
            ["facebook", FACEBOOK_DM_TRIGGER_TYPES],
            ["twitter", TWITTER_DM_TRIGGER_TYPES],
          ] as const
        ).flatMap(([platformName, triggerTypes]) => [
          {
            properties: {
              platform: { const: platformName },
              triggerType: { enum: triggerTypes },
              replyMessage: {
                maxLength: platformName === "twitter" ? 10_000 : 1_000,
              },
            },
            required: [
              "platform",
              "connectionId",
              "name",
              "triggerType",
              "replyMessage",
              "enabled",
            ],
            not: { required: ["id"] },
          },
          {
            properties: {
              platform: { const: platformName },
              triggerType: { enum: triggerTypes },
              replyMessage: {
                maxLength: platformName === "twitter" ? 10_000 : 1_000,
              },
            },
            required: ["platform", "id"],
          },
        ]),
      ],
    ),
    writeTool(
      "set_auto_dm_enabled",
      "Enable or pause Auto-DM",
      "Enables or pauses an owned Auto-DM automation after provider-readiness validation.",
      "set_auto_dm_enabled",
      { platform: autoDmPlatform, id: id("Automation ID."), enabled: boolean("Enabled state.") },
      ["platform", "id", "enabled"],
      refresh,
    ),
    writeTool(
      "delete_auto_dm_automation",
      "Delete Auto-DM automation",
      "Permanently deletes an owned Auto-DM automation.",
      "delete_auto_dm_automation",
      { platform: autoDmPlatform, id: id("Automation ID.") },
      ["platform", "id"],
      refresh,
    ),
    writeTool(
      "manage_page",
      "Manage Bento page",
      "Creates, renames, or deletes a secondary Bento page.",
      "manage_page",
      {
        action: string("Page action.", { enum: ["create", "rename", "delete"] }),
        id: id("Page ID for rename or delete."),
        name: string("Page name for create or rename."),
        url: nullableString("Optional external page URL."),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        create: { required: ["name"], optional: ["url"] },
        rename: ["id", "name"],
        delete: ["id"],
      }),
    ),
    writeTool(
      "manage_block",
      "Manage Bento block",
      "Creates, updates, lays out, or deletes blocks using the same validated editor operation layer.",
      "manage_block",
      {
        action: string("Block action.", { enum: ["create", "update", "layout", "delete"] }),
        id: id("Block ID for update or delete."),
        pageId: nullableId("Optional secondary page ID."),
        type: string("Bento block type.", {
          enum: [
            "social_link",
            "generic_link",
            "image",
            "image_gallery",
            "video",
            "spotify",
            "link_preview",
            "map",
            "heading",
            "note",
            "quote",
            "email_capture",
            "booking",
            "tip_jar",
            "contact",
            "audio",
            "file_download",
            "divider",
            "section_title",
            "experience",
            "commerce",
          ],
        }),
        content: { type: "object", description: "Block content." },
        coverUrl: nullableString("Optional public cover URL."),
        width: number("Grid width.", { minimum: 1, maximum: 4 }),
        height: number("Grid height.", { minimum: 1, maximum: 6 }),
        x: number("Grid x position.", { minimum: 0 }),
        y: number("Grid y position.", { minimum: 0 }),
        items: array(
          "Complete validated layout items.",
          objectSchema(
            {
              id: id("Block ID."),
              x: number("Grid x position.", { minimum: 0, multipleOf: 1 }),
              y: number("Grid y position.", { minimum: 0, multipleOf: 1 }),
              width: number("Grid width.", { minimum: 1, maximum: 4, multipleOf: 1 }),
              height: number("Grid height.", { minimum: 1, maximum: 6, multipleOf: 1 }),
              position: number("Block ordering position.", { minimum: 0, multipleOf: 1 }),
            },
            ["id", "x", "y", "width", "height", "position"],
          ),
        ),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        create: {
          required: ["type"],
          optional: ["content", "coverUrl", "width", "height", "x", "y", "pageId"],
        },
        update: { required: ["id"], optional: ["content", "coverUrl", "width", "height"] },
        layout: ["items"],
        delete: ["id"],
      }),
    ),
    writeTool(
      "manage_product",
      "Manage Bento product",
      "Creates, updates, publishes, archives, deletes, or adds a product, session, course, webinar, community, or lead form to a page.",
      "manage_product",
      {
        action: string("Product action.", {
          enum: ["create", "update", "set_status", "delete", "add_to_page"],
        }),
        id: id("Product ID for update or status changes."),
        productId: id("Product ID for delete or add-to-page."),
        pageId: nullableId("Optional destination page ID."),
        product,
        addToBento: boolean("Whether a newly created product is added to the Bento page."),
        status: string("Publication status.", { enum: ["published", "archived"] }),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        create: { required: ["product"], optional: ["addToBento", "pageId"] },
        update: ["id", "product"],
        set_status: ["id", "status"],
        add_to_page: { required: ["productId"], optional: ["pageId"] },
        delete: ["productId"],
      }),
    ),
    writeTool(
      "manage_discount_code",
      "Manage discount code",
      "Creates, updates, activates, deactivates, or deletes a Store discount code.",
      "manage_discount_code",
      {
        action: string("Discount action.", { enum: ["save", "delete"] }),
        id: id("Existing discount ID."),
        code: string("Discount code."),
        productId: nullableId("Optional product restriction."),
        discountType: string("Discount type.", { enum: ["percent", "fixed"] }),
        discountValue: number("Discount value.", {
          minimum: 1,
          maximum: 100_000_000,
          multipleOf: 1,
        }),
        currency: nullableString("Currency for fixed discounts.", { pattern: "^[a-z]{3}$" }),
        startsAt: nullableString("Optional ISO start timestamp.", { format: "date-time" }),
        expiresAt: nullableString("Optional ISO expiry timestamp.", { format: "date-time" }),
        maxRedemptions: nullableNumber("Optional total redemption limit.", {
          minimum: 1,
          maximum: 1_000_000,
          multipleOf: 1,
        }),
        maxRedemptionsPerEmail: number("Per-email redemption limit.", {
          minimum: 1,
          maximum: 100,
          multipleOf: 1,
        }),
        isActive: boolean("Whether the code is active."),
      },
      ["action"],
      refresh,
      strictVariants([
        {
          properties: { action: { const: "delete" } },
          required: ["action", "id"],
        },
        {
          properties: {
            action: { const: "save" },
            discountType: { const: "percent" },
          },
          required: ["action", "code", "discountType", "discountValue"],
          optional: [
            "id",
            "productId",
            "currency",
            "startsAt",
            "expiresAt",
            "maxRedemptions",
            "maxRedemptionsPerEmail",
            "isActive",
          ],
        },
        {
          properties: {
            action: { const: "save" },
            discountType: { const: "fixed" },
          },
          required: ["action", "code", "discountType", "discountValue", "currency"],
          optional: [
            "id",
            "productId",
            "startsAt",
            "expiresAt",
            "maxRedemptions",
            "maxRedemptionsPerEmail",
            "isActive",
          ],
        },
      ]),
    ),
    writeTool(
      "manage_order_bump",
      "Manage order bump",
      "Creates, updates, activates, deactivates, or deletes an order bump between two products.",
      "manage_order_bump",
      {
        action: string("Order-bump action.", { enum: ["save", "delete"] }),
        id: id("Existing order-bump ID."),
        primaryProductId: id("Primary product ID."),
        bumpProductId: id("Bump product ID."),
        headline: string("Order-bump headline."),
        description: string("Order-bump description."),
        isActive: boolean("Whether the bump is active."),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        save: {
          required: ["primaryProductId", "bumpProductId", "headline"],
          optional: ["id", "description", "isActive"],
        },
        delete: ["id"],
      }),
    ),
    writeTool(
      "manage_audience",
      "Manage publication audience",
      "Manages publication lists, membership, Broadcast drafts, and sending with publication context.",
      "manage_audience",
      {
        action: string("Audience action.", {
          enum: [
            "create_list",
            "delete_list",
            "set_list_member",
            "save_campaign",
            "delete_campaign",
            "send_campaign",
          ],
        }),
        id: id("List or campaign ID when applicable."),
        publicationId: id("Owned publication ID."),
        listId: id("Audience-list ID."),
        contactId: id("Contact ID."),
        included: boolean("Whether the contact belongs to the list."),
        name: string("List or campaign name.", { minLength: 1, maxLength: 120 }),
        description: string("List description.", { maxLength: 500 }),
        subject: string("Campaign subject.", { minLength: 1, maxLength: 180 }),
        previewText: string("Campaign preview text.", { maxLength: 240 }),
        body: string("Campaign Markdown body.", { minLength: 1, maxLength: 50_000 }),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        create_list: {
          required: ["publicationId", "name"],
          optional: ["description"],
          properties: { name: { maxLength: 80 } },
        },
        delete_list: { required: ["id"], optional: ["publicationId"] },
        set_list_member: {
          required: ["listId", "contactId", "included"],
          optional: ["publicationId"],
        },
        save_campaign: {
          required: ["publicationId", "name", "subject", "body"],
          optional: ["id", "listId", "previewText"],
        },
        delete_campaign: { required: ["id"], optional: ["publicationId"] },
        send_campaign: { required: ["id"], optional: ["publicationId"] },
      }),
    ),
    writeTool(
      "manage_calendar",
      "Manage Calendar",
      "Updates availability, public calendar state, review visibility, and Google Calendar or Fathom connections.",
      "manage_calendar",
      {
        action: string("Calendar action.", {
          enum: [
            "save_availability",
            "set_public_page",
            "rename_public_page",
            "set_review_visibility",
            "set_default_connection",
            "disconnect_connection",
          ],
        }),
        availability,
        enabled: boolean("Enabled or public state."),
        name: string("Public calendar name.", { minLength: 1, maxLength: 40 }),
        reviewId: id("Review ID."),
        isPublic: boolean("Review visibility."),
        type: string("Connection type.", { enum: ["google", "fathom"] }),
        id: id("Calendar or Fathom connection ID."),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        save_availability: ["availability"],
        set_public_page: ["enabled"],
        rename_public_page: ["name"],
        set_review_visibility: ["reviewId", "isPublic"],
        set_default_connection: ["type", "id"],
        disconnect_connection: ["type", "id"],
      }),
    ),
    writeTool(
      "manage_community",
      "Manage Community",
      "Manages members, posts, comments, moderation, settings, and community deletion.",
      "manage_community",
      {
        action: string("Community action.", {
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
        }),
        productId: id("Community product ID."),
        grantId: id("Member grant ID."),
        postId: id("Post ID."),
        contentId: id("Post or comment ID to moderate."),
        email: string("Invitee email.", { format: "email", maxLength: 254 }),
        name: string("Member name.", { maxLength: 120 }),
        role: string("Community role.", { enum: ["member", "moderator"] }),
        notificationsEnabled: boolean("Whether the member receives community notifications."),
        body: string("Post or comment body.", { minLength: 1, maxLength: 10_000 }),
        pinned: boolean("Pinned state."),
        resources: {
          ...array(
            "Post resources.",
            objectSchema(
              {
                label: string("Resource label.", { maxLength: 80 }),
                url: string("Resource URL.", { maxLength: 2_000 }),
              },
              ["label", "url"],
            ),
          ),
          maxItems: 5,
        },
        kind: string("Moderation target type.", { enum: ["post", "comment"] }),
        status: string("Member or moderation status.", {
          enum: ["active", "revoked", "published", "hidden", "removed"],
        }),
        reason: string("Optional moderation reason.", { maxLength: 500 }),
        welcomeMessage: string("Community welcome message.", {
          minLength: 1,
          maxLength: 2_000,
        }),
        rules: string("Community rules.", { maxLength: 5_000 }),
        allowMemberPosts: boolean("Whether members can create posts."),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        invite_member: {
          required: ["productId", "email"],
          optional: ["name", "role", "notificationsEnabled"],
        },
        set_member_status: ["grantId", "status"],
        update_member: ["grantId", "role", "notificationsEnabled"],
        create_post: { required: ["productId", "body"], optional: ["pinned", "resources"] },
        pin_post: ["productId", "postId", "pinned"],
        delete_post: ["productId", "postId"],
        create_comment: {
          required: ["productId", "postId", "body"],
          properties: { body: { maxLength: 3_000 } },
        },
        moderate: {
          required: ["productId", "contentId", "kind", "status"],
          optional: ["reason"],
        },
        update_settings: ["productId", "welcomeMessage", "rules", "allowMemberPosts"],
        delete_community: ["productId"],
      }),
    ),
    writeTool(
      "update_profile",
      "Update creator profile",
      "Updates validated creator profile fields such as username, display name, bio, theme, fonts, pattern, and public-page settings.",
      "update_profile",
      {
        username: string("Creator username.", {
          minLength: 3,
          maxLength: 24,
          pattern: "^[a-z0-9_]+$",
        }),
        display_name: string("Display name.", { maxLength: 60 }),
        bio: string("Public bio.", { maxLength: 280 }),
        avatar_url: string("Public avatar URL.", { maxLength: 2_048 }),
        theme: string("Theme.", { enum: ["light", "dark", "system"] }),
        accent_color: string("Accent color ID or hex color.", {
          maxLength: 20,
          pattern: "^(?:[a-z0-9_-]{1,20}|#[0-9a-fA-F]{6})$",
        }),
        primary_font: nullableString("Body font.", { maxLength: 60 }),
        secondary_font: nullableString("Headline font.", { maxLength: 60 }),
        onboarded: boolean("Whether creator onboarding is complete."),
        noindex: boolean("Whether search engines should avoid indexing the creator page."),
        show_in_explore: boolean("Whether the creator is eligible for Explore."),
        store_page_enabled: boolean("Whether the public Store page is enabled."),
        explore_category: string("Explore category.", { enum: [...EXPLORE_CATEGORY_IDS] }),
        header_mode: string("Profile header mode.", { enum: ["with_photo", "no_banner"] }),
        pattern: string("Background pattern ID.", { enum: PATTERNS.map((pattern) => pattern.id) }),
        pattern_settings: {
          type: "object",
          description: "Background pattern intensity, opacity, blur, overlay, scale, and motion.",
          additionalProperties: false,
          properties: {
            intensity: number("Pattern intensity.", { minimum: 0, maximum: 100 }),
            opacity: number("Pattern opacity.", { minimum: 0, maximum: 100 }),
            blur: number("Pattern blur.", { minimum: 0, maximum: 40 }),
            overlay: string("Overlay color.", { pattern: "^#[0-9a-fA-F]{6}$" }),
            overlay_strength: number("Overlay strength.", { minimum: 0, maximum: 100 }),
            image_url: string("Pattern image URL.", { maxLength: 2_048 }),
            parallax: boolean("Whether pointer-based parallax is enabled."),
          },
        },
      },
      [],
      refresh,
    ),
    writeTool(
      "manage_earn",
      "Manage referrals and payouts",
      "Updates the referral code or requests an eligible referral payout.",
      "manage_earn",
      {
        action: string("Earn action.", { enum: ["update_code", "request_payout"] }),
        code: string("New referral code.", { minLength: 3, maxLength: 32 }),
        currency: string("Three-letter payout currency.", { pattern: "^[A-Za-z]{3}$" }),
      },
      ["action"],
      refresh,
      discriminatedVariants("action", {
        update_code: ["code"],
        request_payout: ["currency"],
      }),
    ),
  ];
}
