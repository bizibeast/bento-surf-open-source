import { useEffect, useRef, useState } from "react";
import { collides } from "react-grid-layout/core";
import {
  BlockRenderer,
  isCompletePublicBlock,
  type Block,
} from "@/components/blocks/BlockRenderer";
import { SystemPageTile } from "@/components/pages/SystemPageTile";
import {
  mergeSystemItemLayout,
  type SystemPageItem,
  type SystemItemLayout,
} from "@/lib/page-system-layout";
import { roundedGridRect } from "@/lib/grid-geometry";

// --- Grid identical to editor (read-only) ---
const GRID_MARGIN = 12;
const GRID_COLS_DESKTOP = 8;
const GRID_COLS_PHONE = 4;
const PREVIEW_GRID_WIDTH = 680;

type PackItem = { i: string; x: number; y: number; w: number; h: number };

function packLayout(items: Array<{ i: string; w: number; h: number }>, cols: number): PackItem[] {
  const occupied = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  const isFree = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) if (occupied.has(key(x + dx, y + dy))) return false;
    return true;
  };
  const occupy = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) occupied.add(key(x + dx, y + dy));
  };
  const placed: PackItem[] = [];
  for (const it of items) {
    const w = Math.min(Math.max(it.w, 1), cols);
    const h = Math.max(it.h, 1);
    let done = false;
    for (let y = 0; !done; y++) {
      for (let x = 0; x <= cols - w; x++) {
        if (isFree(x, y, w, h)) {
          placed.push({ i: it.i, x, y, w, h });
          occupy(x, y, w, h);
          done = true;
          break;
        }
      }
    }
  }
  return placed;
}

export function PublicSystemPageCanvas({
  blocks,
  systemItems = [],
  systemLayout = [],
  username = "",
  onBlockClick = () => {},
  liveSocialEnabled = false,
  previewMode = false,
}: {
  blocks: (Omit<Block, "content"> & {
    content: unknown;
    x: number;
    y: number;
    w: number;
    h: number;
    position?: number;
  })[];
  systemItems?: SystemPageItem[];
  systemLayout?: SystemItemLayout[];
  username?: string;
  onBlockClick?: (id: string) => void;
  liveSocialEnabled?: boolean;
  previewMode?: boolean;
}) {
  const publicBlocks = blocks.filter((block) =>
    isCompletePublicBlock({
      ...block,
      content:
        block.content && typeof block.content === "object" && !Array.isArray(block.content)
          ? block.content
          : {},
    } as Block),
  );
  const hasHiddenBlocks = publicBlocks.length !== blocks.length;
  const tiles = [
    ...publicBlocks.map((block) => ({
      ...block,
      block,
      systemItem: undefined as SystemPageItem | undefined,
    })),
    ...mergeSystemItemLayout(systemItems, systemLayout).flatMap(({ itemKey, ...geometry }) => {
      const systemItem = systemItems.find((item) => item.key === itemKey);
      return systemItem
        ? [
            {
              id: `system:${itemKey}`,
              ...geometry,
              h: systemItem.kind === "account" ? Math.min(geometry.h, 2) : geometry.h,
              systemItem,
              block: undefined,
            },
          ]
        : [];
    }),
  ].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  // System canvases use the same combined visual order as the editor.
  const orderedTiles = systemItems.length
    ? tiles.map((tile, position) => ({ ...tile, position }))
    : tiles;
  const ref = useRef<HTMLDivElement>(null);
  // Browser Rendering can capture the server-rendered shell before hydration.
  // The preview route always uses the 1200 px OG viewport, whose desktop grid
  // is exactly 680 px wide. Rendering at that width immediately keeps both the
  // Explore card and social share image complete even when JavaScript is slow.
  const [width, setWidth] = useState(previewMode ? PREVIEW_GRID_WIDTH : 0);
  const [captureReady, setCaptureReady] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const update = () => {
      if (ref.current) setWidth(ref.current.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!previewMode || width <= 0 || !ref.current) return;
    let cancelled = false;
    const root = ref.current;

    const waitForImage = async (image: HTMLImageElement) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
          window.setTimeout(done, 3_000);
        });
      }
      await image.decode?.().catch(() => undefined);
    };

    const markCaptureReady = async () => {
      await document.fonts?.ready.catch(() => undefined);
      await Promise.all(Array.from(root.querySelectorAll("img")).map(waitForImage));
      // Two frames ensure layout and paint have both observed the hydrated grid.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (cancelled) return;

      const items = Array.from(root.querySelectorAll<HTMLElement>("[data-bento-public-grid-item]"));
      const allItemsVisible =
        items.length === orderedTiles.length &&
        items.every((item) => {
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.bottom > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        });
      setCaptureReady(allItemsVisible);
    };

    void markCaptureReady();
    return () => {
      cancelled = true;
    };
  }, [blocks, systemItems, systemLayout, orderedTiles.length, previewMode, width]);

  const isPhone = width > 0 && width < 640;
  const cols = isPhone ? GRID_COLS_PHONE : GRID_COLS_DESKTOP;
  const cellW = width > 0 ? Math.max(40, (width - GRID_MARGIN * (cols + 1)) / cols) : 0;
  const hasUnplacedBlocks = orderedTiles.some(
    (block) => !Number.isFinite(block.y) || block.y >= 9_999,
  );
  const hasOverlaps = orderedTiles.some((tile, index) =>
    orderedTiles
      .slice(index + 1)
      .some((other) =>
        collides(
          { i: tile.id, x: tile.x, y: tile.y, w: tile.w, h: tile.h },
          { i: other.id, x: other.x, y: other.y, w: other.w, h: other.h },
        ),
      ),
  );

  const layout: PackItem[] =
    isPhone || hasHiddenBlocks || hasUnplacedBlocks || hasOverlaps
      ? packLayout(
          [...orderedTiles]
            .sort(
              (a, b) =>
                (a.position ?? 0) - (b.position ?? 0) ||
                a.y - b.y ||
                a.x - b.x ||
                a.id.localeCompare(b.id),
            )
            .map((b) => ({ i: b.id, w: Math.min(b.w, cols), h: b.h })),
          cols,
        )
      : orderedTiles.map((b) => ({
          i: b.id,
          x: Math.min(b.x, Math.max(0, cols - Math.min(b.w, cols))),
          y: b.y,
          w: Math.min(b.w, cols),
          h: b.h,
        }));

  const posById = new Map(layout.map((l) => [l.i, l]));
  const maxRow = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  const totalH = maxRow * cellW + (maxRow + 1) * GRID_MARGIN;

  return (
    <div
      ref={ref}
      data-bento-public-block-grid-ready={
        previewMode ? (captureReady ? "true" : "false") : width > 0 ? "true" : "false"
      }
      data-bento-public-block-count={orderedTiles.length}
      className={width > 0 ? "relative w-full" : "grid w-full gap-3 sm:grid-cols-2"}
      style={{ height: width > 0 ? totalH : undefined }}
    >
      {orderedTiles.map((b) => {
        const l = posById.get(b.id);
        if (!l) return null;
        const rect = roundedGridRect({
          x: l.x,
          y: l.y,
          w: l.w,
          h: l.h,
          cellSize: cellW,
          gap: GRID_MARGIN,
        });
        return (
          <div
            key={b.id}
            data-bento-public-grid-item={b.id}
            className={`${width > 0 ? "absolute" : "relative min-h-48"} overflow-hidden rounded-[28px]`}
            style={width > 0 ? rect : undefined}
            onClickCapture={() => {
              if (b.block) onBlockClick(b.id);
            }}
          >
            {b.systemItem ? (
              <SystemPageTile item={b.systemItem} publicUsername={username} />
            ) : (
              <BlockRenderer
                block={
                  {
                    ...b.block,
                    content:
                      b.block?.content &&
                      typeof b.block.content === "object" &&
                      !Array.isArray(b.block.content)
                        ? b.block.content
                        : {},
                    w: l.w,
                    h: l.h,
                  } as Block
                }
                liveSocialEnabled={liveSocialEnabled}
                emailCaptureInteractive={!previewMode}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
