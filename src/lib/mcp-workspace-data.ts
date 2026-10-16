import { z } from "zod";

export const MCP_WORKSPACE_COLLECTIONS = [
  "brain_items",
  "brain_sources",
  "routines",
  "routine_runs",
  "discover_items",
  "social_accounts",
  "social_posts",
  "social_history",
] as const;

const recordId = z.union([z.string().uuid(), z.string().regex(/^[1-9][0-9]{0,18}$/)]);
export const readWorkspaceDataSchema = z
  .object({
    collection: z.enum(MCP_WORKSPACE_COLLECTIONS),
    cursor: recordId.optional(),
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
      if (numeric !== (input.collection === "social_history"))
        context.addIssue({
          code: "custom",
          message: "Use the record ID or cursor returned by this collection.",
        });
    }
    if (input.savedOnly && input.collection !== "discover_items")
      context.addIssue({ code: "custom", message: "savedOnly is supported for discover_items." });
    if (
      input.query &&
      !["brain_items", "brain_sources", "discover_items", "social_posts"].includes(input.collection)
    )
      context.addIssue({
        code: "custom",
        message: "query filters Brain/source/Discover titles or social post captions.",
      });
  });

export type ReadWorkspaceDataInput = z.input<typeof readWorkspaceDataSchema>;
export const WORKSPACE_DATA_DESCRIPTION =
  "Read stored Brain documents, imported source text, routines and run history, Discover recommendations/bookmarks, or social account/post/history metrics. Workspace-owned data only; no scraping, refresh, generation or provider calls. Pages contain at most 25 records in stable ID order, text previews and nextCursor. Pass nextCursor back as cursor with the same filters until hasMore is false. Pass an item's id to read its full text. Analytics honors plan history limits. Use overview tools for the latest summaries and this tool for complete records and older pages.";
