import { z } from "zod";
import { schedulerReadFiltersShape } from "./mcp-scheduler-read";

export const MCP_WORKSPACE_COLLECTIONS = [
  "brain_items",
  "brain_sources",
  "routines",
  "routine_runs",
  "discover_items",
  "social_accounts",
  "social_posts",
  "scheduler_posts",
  "social_history",
] as const;

const recordId = z.union([z.string().uuid(), z.string().regex(/^[1-9][0-9]{0,18}$/)]);
export const readWorkspaceDataSchema = z
  .object({
    collection: z.enum(MCP_WORKSPACE_COLLECTIONS),
    ...schedulerReadFiltersShape,
    cursor: z.string().min(1).max(512).optional(),
    status: z
      .enum([
        "draft",
        "scheduled",
        "publishing",
        "published",
        "partially_failed",
        "failed",
        "cancelled",
      ])
      .optional(),
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .toLowerCase()
      .optional()
      .describe(
        "Imported social_posts content type, e.g. video. Input is trimmed and normalized to lowercase.",
      ),
    id: recordId.optional(),
    limit: z.number().int().min(1).max(25).default(10),
    query: z.string().trim().min(1).max(120).optional(),
    range: z.enum(["today", "3d", "7d", "30d", "90d", "all"]).default("all"),
    savedOnly: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.id && input.cursor)
      context.addIssue({
        code: "custom",
        message: "Use id for a full record or cursor for a page, not both.",
      });
    for (const value of [input.id, input.cursor].filter(Boolean)) {
      const numeric = /^[1-9][0-9]*$/.test(value!);
      if (
        input.collection !== "scheduler_posts" &&
        (numeric !== (input.collection === "social_history") || !recordId.safeParse(value).success)
      )
        context.addIssue({
          code: "custom",
          message: "Use the record ID or cursor returned by this collection.",
        });
    }
    if (
      (input.targetStatus || input.status || input.dateField !== "published_at") &&
      input.collection !== "scheduler_posts"
    )
      context.addIssue({
        code: "custom",
        message: "status, targetStatus and dateField apply to scheduler_posts only.",
      });
    if (input.contentType && input.collection !== "social_posts")
      context.addIssue({
        code: "custom",
        message: "contentType applies to imported social_posts only.",
      });
    if (
      (input.provider || input.connectionId || input.dateFrom || input.dateTo) &&
      !["social_posts", "social_history", "social_accounts", "scheduler_posts"].includes(
        input.collection,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Social filters apply to social and Scheduler collections only.",
      });
    if ((input.dateFrom || input.dateTo) && input.collection === "social_accounts")
      context.addIssue({
        code: "custom",
        message: "Social account snapshots are latest values; use social_history for date filters.",
      });
    if (input.dateFrom && input.dateTo && Date.parse(input.dateFrom) >= Date.parse(input.dateTo))
      context.addIssue({ code: "custom", message: "dateFrom must precede dateTo (exclusive)." });
    if (input.collection === "scheduler_posts" && input.range !== "all")
      context.addIssue({
        code: "custom",
        message: "Use dateFrom/dateTo for Scheduler date filters.",
      });
    if (input.savedOnly && input.collection !== "discover_items")
      context.addIssue({ code: "custom", message: "savedOnly is supported for discover_items." });
    if (
      input.query &&
      ![
        "brain_items",
        "brain_sources",
        "discover_items",
        "social_posts",
        "scheduler_posts",
      ].includes(input.collection)
    )
      context.addIssue({
        code: "custom",
        message: "query filters Brain/source/Discover titles or social post captions.",
      });
  });

export type ReadWorkspaceDataInput = z.input<typeof readWorkspaceDataSchema>;
export const WORKSPACE_DATA_DESCRIPTION =
  "Read stored Brain documents, imported source text, routines and run history, Discover recommendations/bookmarks, or social account/post/history metrics. social_posts means imported social analytics; scheduler_posts means Scheduler drafts/publications (use get_social_post for metrics and attempt history). provider/connectionId/dateFrom/dateTo filter social data; social_posts also accepts contentType (e.g. video, normalized to lowercase). Scheduler status is the parent state and targetStatus the destination state. Scheduler dates default to destination published_at, not creation time. Workspace-owned data only; no scraping, refresh, generation or provider calls. Pages contain at most 25 records in stable order (Scheduler newest created_at then ID; other collections ID), text previews and nextCursor. Pass nextCursor back as cursor with the same filters until hasMore is false. Pass an item's id to read its full text. Analytics honors plan history limits. Use overview tools for the latest summaries and this tool for complete records and older pages.";
