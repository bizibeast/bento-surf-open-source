const PRODUCT_ANALYTICS_PATHS = new Set([
  "/",
  "/signup",
  "/login",
  "/onboarding",
  "/link",
  "/analytics",
]);

export function isTrackedProductPath(pathname: string) {
  return (
    PRODUCT_ANALYTICS_PATHS.has(pathname) ||
    pathname === "/tools" ||
    pathname.startsWith("/tools/") ||
    pathname === "/store" ||
    pathname.startsWith("/p/") ||
    /^\/@[^/]+\/products\/[^/]+(?:\/success)?\/?$/.test(pathname)
  );
}

export function isReplayableProductPath(pathname: string) {
  return (
    PRODUCT_ANALYTICS_PATHS.has(pathname) ||
    (pathname.startsWith("/p/") && !pathname.endsWith("/success")) ||
    /^\/@[^/]+\/products\/[^/]+\/?$/.test(pathname)
  );
}

export const isHeatmapProductPath = isReplayableProductPath;
