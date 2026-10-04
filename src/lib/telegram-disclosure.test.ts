import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

it("documents Telegram configuration, privacy, and deletion", () => {
  expect(read(".env.example")).toContain("TELEGRAM_WEBHOOK_SECRET=");
  expect(read("src/routes/privacy.tsx")).toContain("Telegram");
  expect(read("src/routes/privacy.tsx")).toContain("180 days");
  expect(read("src/routes/data-deletion.tsx")).toContain("Remove Telegram data");
});
