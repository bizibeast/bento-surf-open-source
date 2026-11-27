import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sharedShellSurfaces = ["routes/$username_.store.tsx"];

const directFontSurfaces = ["routes/access.$token.tsx"];

describe("creator-owned commerce typography", () => {
  it("inherits confirmation typography through the shared product theme", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/routes/$username_.products.$productSlug_.success.tsx"),
      "utf8",
    );
    expect(source).toContain(
      'import { PublicProductTheme } from "@/components/public/PublicProductTheme"',
    );
    expect(source).toContain("<PublicProductTheme");
    expect(source).toContain("creator={data.chrome.creator}");
  });

  it.each(sharedShellSurfaces)("applies shared creator fonts on %s", async (path) => {
    const source = await readFile(resolve(process.cwd(), "src", path), "utf8");
    expect(source).toContain(
      'import { PublicCreatorShell } from "@/components/public/PublicCreatorShell"',
    );
    expect(source).toContain("<PublicCreatorShell");
  });

  it.each(directFontSurfaces)("applies the creator fonts on %s", async (path) => {
    const source = await readFile(resolve(process.cwd(), "src", path), "utf8");
    expect(source).toContain('import { FontApplier } from "@/components/FontApplier"');
    expect(source).toContain("<FontApplier");
  });

  it("returns creator font choices from every commerce profile query", async () => {
    const [commerce, chrome] = await Promise.all([
      readFile(resolve(process.cwd(), "src/lib/commerce.functions.ts"), "utf8"),
      readFile(resolve(process.cwd(), "src/lib/public-creator-chrome.server.ts"), "utf8"),
    ]);
    expect(commerce.match(/primary_font, secondary_font/g)).toHaveLength(3);
    expect(commerce).toContain("loadPublicCreatorChrome(product.creator_id)");
    expect(chrome).toContain("primary_font, secondary_font");
  });
});

it("shares the Link theme while keeping product websites independent of profile chrome", async () => {
  const source = await readFile(
    resolve(process.cwd(), "src/routes/$username_.products.$productSlug.tsx"),
    "utf8",
  );
  expect(source).toContain("<PublicProductTheme");
  expect(source).not.toContain("<PublicCreatorShell");
  expect(source).not.toContain("creator.avatar_url");
});
