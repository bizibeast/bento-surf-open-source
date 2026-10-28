// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { resolveFirstTouch } from "./analytics-identity";
import {
  FIRST_LANDING_COOKIE,
  buildFirstLanding,
  firstLandingCookieDomain,
  hasPostHogCookie,
  isFirstLandingPath,
  parseFirstLanding,
  readFirstLanding,
  recordFirstLanding,
} from "./first-landing";

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

afterEach(() => {
  clearCookies();
  window.history.replaceState(null, "", "/");
});

describe("buildFirstLanding", () => {
  it("keeps UTMs, the referrer host and the path only", () => {
    expect(
      buildFirstLanding({
        href: "https://bento.surf/pricing?utm_source=peerlist&utm_medium=launch&utm_campaign=oct&token=secret#plans",
        referrer: "https://www.google.com/search?q=private",
      }),
    ).toEqual({
      utm_source: "peerlist",
      utm_medium: "launch",
      utm_campaign: "oct",
      referrer: "google.com",
      path: "/pricing",
    });
  });

  it("treats a same-host or missing referrer as direct", () => {
    expect(
      buildFirstLanding({ href: "https://bento.surf/", referrer: "https://bento.surf/blog" })
        ?.referrer,
    ).toBe("$direct");
    expect(buildFirstLanding({ href: "https://bento.surf/", referrer: "" })?.referrer).toBe(
      "$direct",
    );
  });
});

describe("first landing paths and cookie scope", () => {
  it.each(["/", "/pricing", "/features/ai", "/blog/post", "/compare/linktree", "/signup"])(
    "records on %s",
    (path) => expect(isFirstLandingPath(path)).toBe(true),
  );

  it.each(["/@maya", "/p/product", "/admin", "/access/token", "/library", "/onboarding"])(
    "does not record on %s",
    (path) => expect(isFirstLandingPath(path)).toBe(false),
  );

  it("scopes the cookie to the shared parent domain", () => {
    expect(firstLandingCookieDomain("bento.surf")).toBe(".bento.surf");
    expect(firstLandingCookieDomain("app.bento.surf")).toBe(".bento.surf");
    expect(firstLandingCookieDomain("app.test.bento.surf")).toBe(".test.bento.surf");
    expect(firstLandingCookieDomain("test.bento.surf")).toBe(".test.bento.surf");
    expect(firstLandingCookieDomain("localhost")).toBeNull();
  });

  it("detects an existing PostHog cookie", () => {
    expect(hasPostHogCookie("a=1; ph_phc_abc_posthog=%7B%7D")).toBe(true);
    expect(hasPostHogCookie("a=1; bento_first_landing=x")).toBe(false);
  });
});

describe("recordFirstLanding", () => {
  it("records once and never overwrites the first touch", () => {
    window.history.replaceState(null, "", "/pricing?utm_source=ig&secret=1");
    recordFirstLanding("/pricing");
    window.history.replaceState(null, "", "/features?utm_source=later");
    recordFirstLanding("/features");
    expect(readFirstLanding()).toMatchObject({ utm_source: "ig", path: "/pricing" });
    expect(document.cookie).not.toContain("secret");
  });

  it("skips excluded routes and browsers that already have a PostHog first touch", () => {
    window.history.replaceState(null, "", "/@maya?utm_source=ig");
    recordFirstLanding("/@maya");
    expect(readFirstLanding()).toBeNull();

    document.cookie = "ph_phc_key_posthog=%7B%7D; path=/";
    window.history.replaceState(null, "", "/pricing?utm_source=ig");
    recordFirstLanding("/pricing");
    expect(readFirstLanding()).toBeNull();
  });

  it("ignores a malformed cookie", () => {
    expect(parseFirstLanding(`${FIRST_LANDING_COOKIE}=not-json`)).toBeNull();
  });
});

describe("resolveFirstTouch with a first landing record", () => {
  it("prefers the recorded first landing over posthog-js initial info", () => {
    expect(
      resolveFirstTouch(
        { r: "$direct", u: "https://app.bento.surf/login" },
        {},
        {
          utm_source: null,
          utm_medium: null,
          utm_campaign: null,
          referrer: "google.co.in",
          path: "/pricing",
        },
      ),
    ).toEqual({
      first_utm_source: null,
      first_utm_medium: null,
      first_utm_campaign: null,
      first_referrer: "google.co.in",
      first_landing_path: "/pricing",
      first_channel: "organic search",
    });
  });
});
