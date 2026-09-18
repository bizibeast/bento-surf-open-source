import { collides } from "react-grid-layout/core";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";

export const MAX_SYSTEM_PAGE_ITEMS = 200;
export const SYSTEM_PAGE_GRID_COLUMNS = 8;
export const MAX_SYSTEM_PAGE_Y = 10_000;
export const MAX_SYSTEM_PAGE_ITEM_HEIGHT = 1_000;
export const SYSTEM_PAGE_CAPACITY_ERROR = "System pages support at most 200 items.";
export const SYSTEM_PAGE_NO_SPACE_ERROR =
  "System page layout has no available space within the supported grid.";

export type SystemPageItem = {
  key: string;
  pageId: string;
  system: "calendar" | "store" | "insights" | "newsletter";
  kind: "intro" | "session" | "review" | "product" | "summary" | "account" | "publication";
  title: string;
  data: Record<string, Json | undefined>;
  defaultW: number;
  defaultH: number;
};

export const systemItemLayoutSchema = z
  .object({
    itemKey: z.string().min(1).max(120),
    x: z
      .number()
      .int()
      .min(0)
      .max(SYSTEM_PAGE_GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(MAX_SYSTEM_PAGE_Y),
    w: z.number().int().min(1).max(SYSTEM_PAGE_GRID_COLUMNS),
    h: z.number().int().min(1).max(MAX_SYSTEM_PAGE_ITEM_HEIGHT),
    position: z
      .number()
      .int()
      .min(0)
      .max(MAX_SYSTEM_PAGE_ITEMS - 1),
  })
  .refine((item) => item.x + item.w <= SYSTEM_PAGE_GRID_COLUMNS, "Item must fit the grid.");

export type SystemItemLayout = z.infer<typeof systemItemLayoutSchema>;

export function defaultSystemItemLayout(
  items: readonly SystemPageItem[],
  columns = SYSTEM_PAGE_GRID_COLUMNS,
) {
  return mergeSystemItemLayout(items, [], columns);
}

export function mergeSystemItemLayout(
  items: readonly SystemPageItem[],
  saved: readonly SystemItemLayout[],
  columns = SYSTEM_PAGE_GRID_COLUMNS,
): SystemItemLayout[] {
  if (items.length > MAX_SYSTEM_PAGE_ITEMS) throw new Error(SYSTEM_PAGE_CAPACITY_ERROR);
  z.number().int().min(1).max(SYSTEM_PAGE_GRID_COLUMNS).parse(columns);
  const keys = new Set(items.map((item) => item.key));
  if (
    keys.size !== items.length ||
    new Set(saved.map((item) => item.itemKey)).size !== saved.length
  ) {
    throw new Error("System item keys must be unique.");
  }
  const layout = saved
    .filter((item) => keys.has(item.itemKey))
    .map((item) => systemItemLayoutSchema.parse(item))
    .sort((a, b) => a.position - b.position || a.itemKey.localeCompare(b.itemKey))
    .map((item, position) => ({ ...item, position }));
  const placed = new Set(layout.map((item) => item.itemKey));
  for (const item of items) {
    if (placed.has(item.key)) continue;
    const w = Math.min(
      columns,
      z.number().int().positive().max(SYSTEM_PAGE_GRID_COLUMNS).parse(item.defaultW),
    );
    const h = z.number().int().positive().max(MAX_SYSTEM_PAGE_ITEM_HEIGHT).parse(item.defaultH);
    let slot: { x: number; y: number } | undefined;
    for (let y = 0; y <= MAX_SYSTEM_PAGE_Y && !slot; y++) {
      for (let x = 0; x <= columns - w; x++) {
        if (
          !layout.some((other) =>
            collides({ i: item.key, x, y, w, h }, { ...other, i: other.itemKey }),
          )
        ) {
          slot = { x, y };
          break;
        }
      }
    }
    if (!slot) throw new Error(SYSTEM_PAGE_NO_SPACE_ERROR);
    layout.push(
      systemItemLayoutSchema.parse({
        itemKey: item.key,
        ...slot,
        w,
        h,
        position: layout.length,
      }),
    );
  }
  return layout;
}
