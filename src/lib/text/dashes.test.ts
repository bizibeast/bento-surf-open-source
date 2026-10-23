import { describe, expect, it } from "vitest";
import {
  normalizeCustomerCopy,
  normalizeDashes,
  normalizeOptionalCopy,
  proseHasForbiddenDash,
  textHasForbiddenDash,
} from "./dashes";

const em = "\u2014";
const en = "\u2013";
const bar = "\u2015";
const figure = "\u2012";
const twoEm = "\u2E3A";
const smallEm = "\uFE58";

describe("dash policy", () => {
  it("flags em dashes, horizontal bars, and en dashes used as dashes", () => {
    expect(proseHasForbiddenDash(`One idea${em}then the next`)).toBe(true);
    expect(proseHasForbiddenDash(`Title${en}subtitle`)).toBe(true);
    expect(proseHasForbiddenDash(`A line${bar}continued`)).toBe(true);
    expect(proseHasForbiddenDash(`Figure${figure}dash`)).toBe(true);
    expect(proseHasForbiddenDash(`Wide${twoEm}break`)).toBe(true);
    expect(proseHasForbiddenDash(`Small${smallEm}dash`)).toBe(true);
  });

  it("allows numeric en-dash ranges and spaced ASCII hyphens", () => {
    expect(proseHasForbiddenDash(`Ship 10${en}20 drafts`)).toBe(false);
    expect(proseHasForbiddenDash(`Pages 1,000${en}1,200`)).toBe(false);
    expect(proseHasForbiddenDash("Use a hyphen - when you need a pause")).toBe(false);
  });

  it("normalises prose dashes and numeric ranges without touching spaced hyphens", () => {
    expect(normalizeDashes(`One idea${em}then the next`)).toBe("One idea - then the next");
    expect(normalizeDashes(`Title ${en} subtitle`)).toBe("Title - subtitle");
    expect(normalizeDashes(`A line${bar}continued`)).toBe("A line - continued");
    expect(normalizeDashes(`Ship 10${en}20 drafts`)).toBe("Ship 10-20 drafts");
    expect(normalizeDashes(`${em}Hello`)).toBe("- Hello");
    expect(normalizeDashes(`Hello${em}`)).toBe("Hello -");
    expect(normalizeDashes("Use a hyphen - when you need a pause")).toBe(
      "Use a hyphen - when you need a pause",
    );
    expect(normalizeDashes(normalizeDashes(`One idea${em}then the next`))).toBe(
      "One idea - then the next",
    );
    expect(normalizeDashes(`a${em}${em}b`)).toBe("a - b");
    expect(normalizeDashes(`a${em} ${em}b`)).toBe("a - b");
    expect(normalizeDashes(`10${en}20${en}30`)).toBe("10-20-30");
    expect(normalizeDashes(`10 ${en} 20 ${en} 30`)).toBe("10-20-30");
    expect(textHasForbiddenDash(`10${en}20${en}30`)).toBe(false);
    expect(textHasForbiddenDash(`See \`a${em}b\` now`)).toBe(true);
    expect(textHasForbiddenDash(`https://example.com/a${em}b`)).toBe(true);
  });

  it("leaves URLs and code untouched", () => {
    const url = `See https://example.com/a${em}b${en}c for the source.`;
    expect(normalizeDashes(url)).toBe(url);
    expect(proseHasForbiddenDash(url)).toBe(false);

    const inline = `Call \`a${em}b\` then continue.`;
    expect(normalizeDashes(inline)).toBe(inline);
    expect(proseHasForbiddenDash(inline)).toBe(false);
    expect(textHasForbiddenDash(inline)).toBe(true);

    const fenced = `Before\n\`\`\`\nkeep${em}this\n\`\`\`\nAfter${em}done`;
    expect(normalizeDashes(fenced)).toBe(`Before\n\`\`\`\nkeep${em}this\n\`\`\`\nAfter - done`);
    expect(proseHasForbiddenDash(fenced)).toBe(true);

    const mixed = `Read https://example.com/a${em}b ${em} then ship.`;
    expect(normalizeDashes(mixed)).toBe(`Read https://example.com/a${em}b - then ship.`);
    expect(proseHasForbiddenDash(mixed)).toBe(true);
    expect(normalizeOptionalCopy(undefined)).toBeNull();
    expect(normalizeCustomerCopy({ body: `A${em}B`, n: 1, url: `https://x.com/a${em}b` })).toEqual({
      body: "A - B",
      n: 1,
      url: `https://x.com/a${em}b`,
    });
  });
});
