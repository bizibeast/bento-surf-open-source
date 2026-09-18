import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PublicCreatorShell } from "./PublicCreatorShell";
import type { PublicCreatorChrome } from "@/lib/public-creator-chrome.server";

const chrome = {
  creator: {
    username: "bizibeast",
    display_name: "Bizibeast",
    bio: "Helping you make money online",
    avatar_url: "https://example.com/avatar.png",
    theme: "dark",
    accent_color: "indigo",
    pattern: "none",
    header_mode: "with_photo",
    badge_hidden: false,
    is_pro: true,
  },
  pages: ["About", "Calendar", "Store", "Insights", "Newsletters"].map((name) => ({
    id: name,
    name,
    slug: name.toLowerCase(),
    href: `/@bizibeast/${name.toLowerCase()}`,
    url: null,
    system: null,
  })),
  customDomain: null,
} as PublicCreatorChrome;
afterEach(cleanup);

it("uses the creator name as the profile page heading", () => {
  render(
    <PublicCreatorShell chrome={chrome} activePageId={null}>
      <p>Home body</p>
    </PublicCreatorShell>,
  );

  expect(screen.getByRole("heading", { level: 1, name: /Bizibeast/ })).toBeVisible();
});

it("always shows identity and every ordered page around the route body", () => {
  render(
    <PublicCreatorShell chrome={chrome} activePageId="Calendar">
      <p>Calendar body</p>
    </PublicCreatorShell>,
  );
  expect(document.querySelector("aside > p")).toHaveTextContent("Bizibeast");
  expect(screen.getByText("Helping you make money online")).toBeVisible();
  expect(screen.getByText("@bizibeast")).toBeVisible();
  const nav = screen.getByRole("navigation", { name: "Creator pages" });
  expect(within(nav).getByRole("link", { name: "Home page" })).toHaveAttribute(
    "href",
    "/@bizibeast",
  );
  expect(
    within(nav)
      .getAllByRole("link")
      .slice(1)
      .map((link) => link.textContent),
  ).toEqual(["About", "Calendar", "Store", "Insights", "Newsletters"]);
  expect(within(screen.getByRole("main")).getByText("Calendar body")).toBeVisible();
  expect(screen.getByRole("img", { name: "Bizibeast avatar" })).toBeVisible();
  expect(screen.getByRole("link", { name: /Made with/ })).toBeVisible();
});

it("treats no_banner as without photo while keeping identity, navigation and branding", () => {
  render(
    <PublicCreatorShell
      chrome={{ ...chrome, creator: { ...chrome.creator, header_mode: "no_banner" } }}
      activePageId={null}
    >
      Body
    </PublicCreatorShell>,
  );
  expect(screen.queryByRole("img", { name: /avatar/ })).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: /Bizibeast/ })).toBeVisible();
  expect(screen.getByText("@bizibeast")).toBeVisible();
  expect(screen.getByText("Helping you make money online")).toBeVisible();
  expect(screen.getByRole("link", { name: "Home page" })).toBeVisible();
  expect(screen.getByRole("link", { name: /Made with/ })).toBeVisible();
});

it("keeps custom domain home navigation, avatar fallback and badge preferences", () => {
  render(
    <PublicCreatorShell
      chrome={{
        ...chrome,
        customDomain: "creator.example",
        creator: { ...chrome.creator, avatar_url: "javascript:bad", badge_hidden: true },
      }}
      activePageId={null}
    >
      Body
    </PublicCreatorShell>,
  );
  expect(screen.getByRole("link", { name: "Home page" })).toHaveAttribute("href", "/");
  expect(screen.getByText("@bizibeast")).toBeVisible();
  expect(screen.getByText("creator.example")).toBeVisible();
  expect(screen.getByText("B")).toBeVisible();
  expect(screen.queryByRole("img", { name: /avatar/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /Made with/ })).toBeNull();
});

it("retains home navigation when there are no additional public pages", () => {
  render(
    <PublicCreatorShell chrome={{ ...chrome, pages: [] }} activePageId={null}>
      Body
    </PublicCreatorShell>,
  );
  expect(screen.getByRole("link", { name: "Home page" })).toHaveAttribute("href", "/@bizibeast");
});
