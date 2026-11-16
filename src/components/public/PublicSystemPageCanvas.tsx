import { useEffect, useRef, useState } from "react";
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
import {
  GRID_COLS_DESKTOP,
  GRID_COLS_PHONE,
  GRID_MARGIN,
  GRID_PHONE_BREAKPOINT,
  mobileGridLayout,
  resolveGridOverlaps,
  roundedGridRect,
} from "@/lib/grid-geometry";

const PREVIEW_GRID_WIDTH = 680;

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
  const tiles = [
    ...blocks.map((block) => ({
      ...block,
      block: {
        ...block,
        content:
          block.content && typeof block.content === "object" && !Array.isArray(block.content)
            ? (block.content as Block["content"])
            : {},
      },
      systemItem: undefined,
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
  const visibleTiles = tiles.filter((tile) => !tile.block || isCompletePublicBlock(tile.block));
  const ref = useRef<HTMLDivElement>(null);
  // Browser Rendering can capture the server-rendered shell before hydration.
  // The preview route always uses the 1200 px OG viewport, whose desktop grid
  // is exactly 680 px wide. Rendering at that width immediately keeps both the
  // Explore card and social share image complete even when JavaScript is slow.
  const [width, setWidth] = useState(previewMode ? PREVIEW_GRID_WIDTH : 0);
  const [captureReady, setCaptureReady] = useState(false);
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const update = () => {
      if (ref.current) setWidth(ref.current.clientWidth);
      setIsPhone(window.innerWidth < GRID_PHONE_BREAKPOINT);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(ref.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
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
        items.length === visibleTiles.length &&
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
  }, [blocks, systemItems, systemLayout, visibleTiles.length, isPhone, previewMode, width]);

  const cols = isPhone ? GRID_COLS_PHONE : GRID_COLS_DESKTOP;
  const cellW = width > 0 ? Math.max(40, (width - GRID_MARGIN * (cols + 1)) / cols) : 0;
  const desktopLayout = resolveGridOverlaps(
    tiles.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h })),
    GRID_COLS_DESKTOP,
  );
  const layout = isPhone ? mobileGridLayout(desktopLayout) : desktopLayout;
  const posById = new Map(layout.map((item) => [item.i, item]));
  const maxRow = visibleTiles.reduce((max, { id }) => {
    const item = posById.get(id);
    return item ? Math.max(max, item.y + item.h) : max;
  }, 0);
  const totalH = maxRow * cellW + (maxRow + 1) * GRID_MARGIN;

  return (
    <div
      ref={ref}
      data-bento-public-block-grid-ready={
        previewMode ? (captureReady ? "true" : "false") : width > 0 ? "true" : "false"
      }
      data-bento-public-block-count={visibleTiles.length}
      className={width > 0 ? "relative w-full" : "grid w-full gap-3 sm:grid-cols-2"}
      style={{ height: width > 0 ? totalH : undefined }}
    >
      {visibleTiles.map((b) => {
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
              <SystemPageTile item={b.systemItem} publicUsername={username} w={l.w} h={l.h} />
            ) : b.block ? (
              <BlockRenderer
                block={{ ...b.block, w: l.w, h: l.h }}
                liveSocialEnabled={liveSocialEnabled}
                emailCaptureInteractive={!previewMode}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
