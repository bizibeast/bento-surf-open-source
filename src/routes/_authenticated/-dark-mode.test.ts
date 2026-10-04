import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const layout = readFileSync(resolve(process.cwd(), "src/routes/_authenticated.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function relativeLuminance(hex: string) {
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function authenticatedUiSource() {
  const roots = [
    "src/routes/_authenticated",
    "src/components/admin",
    "src/components/content",
    "src/components/email-marketing",
    "src/components/scheduler",
    "src/components/settings",
  ];
  const nested = roots.flatMap((root) =>
    readdirSync(resolve(process.cwd(), root), { recursive: true })
      .filter((file) => String(file).endsWith(".tsx"))
      .map((file) => resolve(process.cwd(), root, String(file))),
  );
  const shared = readdirSync(resolve(process.cwd(), "src/components"))
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => resolve(process.cwd(), "src/components", file));
  return [...nested, ...shared].map((file) => readFileSync(file, "utf8")).join("\n");
}

describe("authenticated dark mode", () => {
  it("marks the document while the authenticated app uses dark mode", () => {
    expect(layout).toContain('classList.toggle("auth-dark", theme === "dark")');
    expect(layout).toContain('classList.remove("auth-dark")');
  });

  it("uses dark-grey semantic surfaces with readable foregrounds", () => {
    expect(styles).toMatch(/\.dark,\s*\.auth-dark\s*\{/);
    expect(styles).toContain("--background: oklch(0.23 0.01 270)");
    expect(styles).toContain("--card: oklch(0.28 0.01 270)");
    expect(styles).toContain("--card-foreground: oklch(0.95 0.003 260)");
  });

  it("normalizes legacy light-only app utilities without changing marketing pages", () => {
    expect(styles).toMatch(/\.auth-dark\s+:where\(\s*\.bg-white/);
    expect(styles).toContain(".auth-light, .auth-light *, [data-bento-public-page]");
    expect(styles).toMatch(/\.auth-dark\s+:where\(\s*\.text-\\\[\\#17213a\\\]/);
    expect(styles).toContain(".text-\\[\\#111111\\]");
    expect(styles).toContain(".text-neutral-900");
    expect(styles).toContain(".bg-neutral-50");
    expect(styles).toContain(".bg-white\\/25");
    expect(styles).toContain(".text-\\[\\#31577f\\]");
  });

  it("covers every light-only hexadecimal surface used by authenticated screens", () => {
    const tokens = authenticatedUiSource().match(/bg-\[#([0-9a-fA-F]{6})\](?:\/[0-9]+)?/g) ?? [];
    const lightSurfaces = [...new Set(tokens)].filter((token) => {
      const hex = token.match(/#([0-9a-fA-F]{6})/)?.[1];
      return hex && relativeLuminance(hex) > 0.72;
    });

    const normalizedSelectors = new Set(styles.match(/\.bg-[^\s,:(]+/g) ?? []);
    const missing = lightSurfaces.filter((token) => {
      const selector = `.${token.replaceAll("[", "\\[").replaceAll("#", "\\#").replaceAll("]", "\\]").replaceAll("/", "\\/")}`;
      return !normalizedSelectors.has(selector);
    });
    expect(missing.join("\n")).toBe("");
  });
});
