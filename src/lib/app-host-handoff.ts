import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";
export function appOriginForPublicHost(hostname: string): string | null {
  const app = new URL(configuredAppOrigin(import.meta.env.VITE_APP_URL));
  const site = new URL(configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL));
  return hostname === site.hostname && app.origin !== site.origin ? app.origin : null;
}
export function redirectPublicHostToAppHost(
  location: Pick<Location, "hostname" | "pathname" | "search" | "hash">,
  replace: (url: string) => void,
): boolean {
  const origin = appOriginForPublicHost(location.hostname);
  if (!origin) return false;
  replace(origin + location.pathname + location.search + location.hash);
  return true;
}
