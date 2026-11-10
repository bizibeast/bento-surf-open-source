import { describe, expect, it } from "vitest";

import {
  OAUTH_SIGNUP_WINDOW_MS,
  isFreshOAuthSignup,
  isTestEmail,
  deriveFirstChannel,
  isSearchEngineHost,
  resolveFirstTouch,
} from "./analytics-identity";

describe("isTestEmail", () => {
  it.each([
    "owner@qa.example.test",
    "owner+release@qa.example.test",
    "anyone@qa.example.test",
    "OWNER+Case@Gmail.com",
    "owner+qa@example.com",
    "stgfix-onboarding-3@example.com",
    "heteyot236@disposable.example",
    "  stgfix1@x.io  ",
  ])("flags %s", (email) => {
    expect(isTestEmail(email)).toBe(true);
  });

  it.each([
    "owner@gmail.com",
    "creator@gmail.com",
    "stg@example.com",
    "fix.stgfix@example.com",
    "someone@notqa.example.test.evil.io",
    "someone@disposable.examplemunity",
    "",
    "not-an-email",
    null,
    undefined,
  ])("does not flag %s", (email) => {
    expect(isTestEmail(email)).toBe(false);
  });
});

describe("isFreshOAuthSignup", () => {
  const now = Date.parse("2026-10-25T12:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("captures a Google account created moments ago", () => {
    expect(isFreshOAuthSignup({ provider: "google", createdAt: minutesAgo(1), now })).toBe(true);
  });

  it("ignores email accounts, which the signup form already captures", () => {
    expect(isFreshOAuthSignup({ provider: "email", createdAt: minutesAgo(1), now })).toBe(false);
  });

  it("ignores returning OAuth logins outside the window", () => {
    expect(
      isFreshOAuthSignup({
        provider: "google",
        createdAt: new Date(now - OAUTH_SIGNUP_WINDOW_MS).toISOString(),
        now,
      }),
    ).toBe(false);
    expect(isFreshOAuthSignup({ provider: "google", createdAt: minutesAgo(9), now })).toBe(true);
  });

  it("ignores missing or invalid data", () => {
    expect(isFreshOAuthSignup({ provider: null, createdAt: minutesAgo(1), now })).toBe(false);
    expect(isFreshOAuthSignup({ provider: "google", createdAt: null, now })).toBe(false);
    expect(isFreshOAuthSignup({ provider: "google", createdAt: "nope", now })).toBe(false);
  });
});

describe("resolveFirstTouch", () => {
  it("reads UTMs and the referrer host from posthog-js initial person info", () => {
    expect(
      resolveFirstTouch({
        r: "https://www.google.com/search?q=private",
        u: "https://bento.surf/?utm_source=peerlist&utm_medium=launch&utm_campaign=oct&email=a@b.c",
      }),
    ).toEqual({
      first_utm_source: "peerlist",
      first_utm_medium: "launch",
      first_utm_campaign: "oct",
      first_referrer: "google.com",
      first_landing_path: "/",
      first_channel: "peerlist",
    });
  });

  it("keeps direct traffic as $direct", () => {
    expect(resolveFirstTouch({ r: "$direct", u: "https://bento.surf/" })).toEqual({
      first_utm_source: null,
      first_utm_medium: null,
      first_utm_campaign: null,
      first_referrer: "$direct",
      first_landing_path: "/",
      first_channel: "direct",
    });
  });

  it("fills gaps from the per-origin localStorage first touch", () => {
    expect(
      resolveFirstTouch(
        { r: "$direct", u: "https://app.bento.surf/signup" },
        { initial_utm_source: "newsletter", initial_referring_domain: "Direct" },
      ),
    ).toMatchObject({
      first_utm_source: "newsletter",
      first_referrer: "$direct",
      first_landing_path: "/signup",
      first_channel: "newsletter",
    });
  });

  it("falls back entirely when posthog-js has no initial info", () => {
    expect(
      resolveFirstTouch(undefined, {
        initial_utm_source: "x",
        initial_utm_medium: "social",
        initial_utm_campaign: "launch",
        initial_referring_domain: "www.t.co",
        initial_landing_path: "/pricing",
      }),
    ).toEqual({
      first_utm_source: "x",
      first_utm_medium: "social",
      first_utm_campaign: "launch",
      first_referrer: "t.co",
      first_landing_path: "/pricing",
      first_channel: "x",
    });
  });

  it("tolerates malformed input", () => {
    expect(resolveFirstTouch({ u: "not a url", r: "also not" })).toEqual({
      first_utm_source: null,
      first_utm_medium: null,
      first_utm_campaign: null,
      first_referrer: null,
      first_landing_path: null,
      first_channel: "direct",
    });
  });

  it("keeps the landing path only, never the query string or hash", () => {
    const touch = resolveFirstTouch({
      r: "$direct",
      u: "https://bento.surf/@maya/links?utm_source=ig&token=secret#frag",
    });
    expect(touch.first_landing_path).toBe("/@maya/links");
    expect(JSON.stringify(touch)).not.toContain("secret");
  });

  it("derives organic search and referral channels from the referrer", () => {
    expect(
      resolveFirstTouch({ r: "https://www.google.co.in/", u: "https://bento.surf/" }).first_channel,
    ).toBe("organic search");
    expect(
      resolveFirstTouch({ r: "https://www.linkedin.com/feed/", u: "https://bento.surf/" }),
    ).toMatchObject({
      first_channel: "referral",
      first_referrer: "linkedin.com",
    });
  });
});

describe("isSearchEngineHost", () => {
  it.each([
    "google.com",
    "www.google.co.uk",
    "news.google.com",
    "bing.com",
    "www.bing.com",
    "duckduckgo.com",
    "search.yahoo.com",
    "yahoo.co.jp",
    "ecosia.org",
    "www.ecosia.org",
  ])("treats %s as a search engine", (host) => {
    expect(isSearchEngineHost(host)).toBe(true);
  });

  it.each(["googleads.example.com", "notbing.com", "linkedin.com", "chatgpt.com", "", null])(
    "does not treat %s as a search engine",
    (host) => {
      expect(isSearchEngineHost(host)).toBe(false);
    },
  );
});

describe("deriveFirstChannel", () => {
  it("prefers the UTM source", () => {
    expect(deriveFirstChannel({ utmSource: "peerlist", referrerHost: "google.com" })).toBe(
      "peerlist",
    );
  });

  it("falls back to organic search, referral, then direct", () => {
    expect(deriveFirstChannel({ utmSource: null, referrerHost: "duckduckgo.com" })).toBe(
      "organic search",
    );
    expect(deriveFirstChannel({ utmSource: " ", referrerHost: "chatgpt.com" })).toBe("referral");
    expect(deriveFirstChannel({ utmSource: null, referrerHost: "$direct" })).toBe("direct");
    expect(deriveFirstChannel({ utmSource: null, referrerHost: null })).toBe("direct");
  });
});
