import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FontApplier } from "./FontApplier";

describe("FontApplier", () => {
  afterEach(() => {
    cleanup();
    document.querySelectorAll('link[id^="gf-"]').forEach((link) => link.remove());
    document.documentElement.style.removeProperty("--font-user-headline");
    document.documentElement.style.removeProperty("--font-user-body");
    document.documentElement.style.removeProperty("--font-display");
    document.documentElement.style.removeProperty("--font-sans");
  });

  it("loads selected fonts and exposes them to the profile UI", () => {
    render(<FontApplier headline="Abril Fatface" body="Plus Jakarta Sans" />);

    expect(document.getElementById("gf-Abril-Fatface")?.getAttribute("href")).toBe(
      "https://fonts.googleapis.com/css2?family=Abril+Fatface&display=swap",
    );
    expect(document.documentElement.style.getPropertyValue("--font-user-headline")).toContain(
      '"Abril Fatface"',
    );
    expect(document.documentElement.style.getPropertyValue("--font-user-body")).toContain(
      '"Plus Jakarta Sans"',
    );
    expect(document.documentElement.style.getPropertyValue("--font-display")).toContain(
      '"Abril Fatface"',
    );
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain(
      '"Plus Jakarta Sans"',
    );
  });

  it("repairs a stale font link created by the previous loader", () => {
    const stale = document.createElement("link");
    stale.id = "gf-Abril-Fatface";
    stale.rel = "stylesheet";
    stale.href =
      "https://fonts.googleapis.com/css2?family=Abril+Fatface:wght@400;500;600;700&display=swap";
    document.head.appendChild(stale);

    render(<FontApplier headline="Abril Fatface" />);

    expect(stale.getAttribute("href")).toBe(
      "https://fonts.googleapis.com/css2?family=Abril+Fatface&display=swap",
    );
  });

  it("keeps Bento-owned UI tokens unchanged when only creator aliases are requested", () => {
    render(
      <FontApplier headline="Abril Fatface" body="Plus Jakarta Sans" applyGlobalTokens={false} />,
    );

    expect(document.documentElement.style.getPropertyValue("--font-user-headline")).toContain(
      '"Abril Fatface"',
    );
    expect(document.documentElement.style.getPropertyValue("--font-user-body")).toContain(
      '"Plus Jakarta Sans"',
    );
    expect(document.documentElement.style.getPropertyValue("--font-display")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("");
  });

  it("restores the app defaults when the profile typography unmounts", () => {
    const { unmount } = render(<FontApplier headline="Abril Fatface" body="Plus Jakarta Sans" />);

    unmount();

    expect(document.documentElement.style.getPropertyValue("--font-user-headline")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-user-body")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-display")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("");
  });
});
