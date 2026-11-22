import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("./browser.ts", import.meta.url)),
      name: "BentoStudioReel",
      formats: ["iife"],
      fileName: () => "reel.js",
    },
    outDir: "dist/studio-reel-renderer",
  },
});
