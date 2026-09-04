import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { PublicAppChrome } from "./PublicAppChrome";

afterEach(() => vi.unstubAllEnvs());

describe("PublicAppChrome", () => {
  it("provides product-entry, legal, and default source navigation", () => {
    render(
      <PublicAppChrome>
        <main>Public content</main>
      </PublicAppChrome>,
    );

    expect(screen.getByRole("navigation", { name: "Public application" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Legal" })).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link")
        .map((link) => new URL(link.getAttribute("href")!, location.href).pathname),
    ).toEqual([
      "/explore",
      "/login",
      "/signup",
      "/privacy",
      "/terms",
      "/bizibeast/bento-surf-open-source",
    ]);
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://github.com/bizibeast/bento-surf-open-source",
    );
  });

  it("uses configured external legal policies", () => {
    vi.stubEnv("VITE_PRIVACY_URL", "https://legal.example/privacy");
    vi.stubEnv("VITE_TERMS_URL", "https://legal.example/terms");
    render(<PublicAppChrome>Public content</PublicAppChrome>);

    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "https://legal.example/privacy",
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "https://legal.example/terms",
    );
  });

  it("shows the configured source link", () => {
    vi.stubEnv("VITE_SOURCE_URL", "https://code.example/bento-surf");
    render(<PublicAppChrome>Public content</PublicAppChrome>);

    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://code.example/bento-surf",
    );
  });
});
