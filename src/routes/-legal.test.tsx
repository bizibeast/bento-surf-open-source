import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { Route as PrivacyRoute } from "./privacy";
import { Route as TermsRoute } from "./terms";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("legal route chrome", () => {
  it.each([
    ["privacy", PrivacyRoute],
    ["terms", TermsRoute],
  ])("wraps the %s page in public application navigation", (_name, route) => {
    const Page = (route as unknown as { options: { component: ComponentType } }).options.component;
    render(<Page />);

    expect(screen.getByRole("navigation", { name: "Public application" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Legal" })).toBeInTheDocument();
  });

  it.each([
    ["privacy", PrivacyRoute],
    ["terms", TermsRoute],
  ])("renders neutral instance-operator %s guidance", (_name, route) => {
    const Page = (route as unknown as { options: { component: ComponentType } }).options.component;
    render(<Page />);
    const text = document.body.textContent ?? "";

    expect(text).toMatch(/instance operator/i);
    expect(text).not.toMatch(/@gmail\.com/i);
    expect(text).not.toMatch(/Cloudflare, Supabase, Resend, PostHog/i);
    expect(text).not.toMatch(/Any bento\.surf fees/i);
    expect(text).not.toMatch(/Free (?:media )?tools/i);
  });

  it("links the configured support address", () => {
    vi.stubEnv("VITE_SUPPORT_EMAIL", "operator@example.com");
    const Page = (PrivacyRoute as unknown as { options: { component: ComponentType } }).options
      .component;
    render(<Page />);

    expect(screen.getByRole("link", { name: "operator@example.com" })).toHaveAttribute(
      "href",
      "mailto:operator@example.com",
    );
  });
});
