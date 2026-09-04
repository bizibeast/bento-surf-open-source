import { defineConfig, loadEnv } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig(({ mode, command }) => {
  // Statically inline VITE_* vars so they are replaced in both the client and
  // SSR/server bundles.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const privateEnv = loadEnv(mode, process.cwd(), "");
  const wranglerResult = parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8"),
  );
  if (wranglerResult.error) throw new Error("wrangler.jsonc is not valid JSONC.");
  const wranglerVars = (wranglerResult.config?.vars ?? {}) as Record<string, string>;
  env.VITE_APP_ENV = mode === "staging" ? "staging" : "production";
  env.VITE_APP_NAME = env.VITE_APP_NAME?.trim() || "Bento Surf";
  env.VITE_APP_URL =
    env.VITE_APP_URL?.trim() ||
    (command === "build" ? wranglerVars.VITE_APP_URL?.trim() : "") ||
    "http://localhost:8080";
  env.VITE_PUBLIC_URL =
    env.VITE_PUBLIC_URL?.trim() ||
    (command === "build" ? wranglerVars.VITE_PUBLIC_URL?.trim() : "") ||
    "http://localhost:8080";
  const uploadPostHogSourceMaps =
    command === "build" &&
    mode === "production" &&
    privateEnv.POSTHOG_UPLOAD_SOURCEMAPS === "1" &&
    Boolean(privateEnv.POSTHOG_PERSONAL_API_KEY);
  const define = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );

  return {
    define,
    build: { sourcemap: uploadPostHogSourceMaps ? "hidden" : false },
    server: { host: "::", port: 8080 },
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    },
    plugins: [
      tailwindcss(),
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        router: {
          codeSplittingOptions: {
            defaultBehavior: [["component"], ["loader"], ["errorComponent"], ["notFoundComponent"]],
          },
        },
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
        // Redirect TanStack Start's bundled server entry to src/server.ts (our
        // SSR error wrapper). nitro/vite builds from this.
        server: { entry: "server" },
      }),
      // Build-only: emit a Cloudflare-targeted server bundle via Nitro.
      // Pin the compatibility date — Nitro otherwise stamps the build date, which
      // Cloudflare rejects as "in the future" if its clock is a day behind.
      ...(command === "build"
        ? [nitro({ defaultPreset: "cloudflare-module", compatibilityDate: "2026-07-01" })]
        : []),
      viteReact(),
    ],
  };
});
