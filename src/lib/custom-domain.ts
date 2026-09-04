import { z } from "zod";
import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";

const hostnameSchema = z
  .string()
  .min(4)
  .max(253)
  .regex(
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/,
    "Enter a valid domain such as links.example.com",
  );

export function normalizeHostname(value: string): string {
  let hostname = value.trim().toLowerCase();
  if (!hostname) throw new Error("Enter a domain to connect.");

  if (hostname.includes("://")) {
    try {
      const url = new URL(hostname);
      if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("Enter a domain without a path.");
      }
      hostname = url.hostname;
    } catch (error) {
      if (error instanceof Error && error.message === "Enter a domain without a path.") throw error;
      throw new Error("Enter a valid domain such as links.example.com");
    }
  }

  hostname = hostname.replace(/\.$/, "");
  const parsed = hostnameSchema.safeParse(hostname);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Enter a valid domain.");

  const labels = hostname.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) {
    throw new Error("Internationalized domains are not supported yet.");
  }
  if (["example", "invalid", "localhost", "test"].includes(labels.at(-1) ?? "")) {
    throw new Error("That domain suffix cannot be connected.");
  }
  return parsed.data;
}

export function hostnameFromRequestHost(host: string | undefined): string | null {
  if (!host) return null;
  const unbracketed = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return unbracketed?.toLowerCase().replace(/\.$/, "") || null;
}

export function isConfiguredInstanceHostname(
  hostname: string,
  env: { VITE_APP_URL?: unknown; VITE_PUBLIC_URL?: unknown },
) {
  const value = hostname.trim().toLowerCase().replace(/\.$/, "");
  const appOrigin = configuredAppOrigin(
    typeof env.VITE_APP_URL === "string" ? env.VITE_APP_URL : undefined,
  );
  const publicOrigin = configuredPublicOrigin(
    typeof env.VITE_PUBLIC_URL === "string" ? env.VITE_PUBLIC_URL : undefined,
  );
  return [appOrigin, publicOrigin].some((origin) => new URL(origin).hostname === value);
}
