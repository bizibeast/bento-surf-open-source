import { describe, expect, it } from "vitest";
import {
  FACEBOOK_CONNECTION_RETURN_TO,
  INSTAGRAM_CONNECTION_RETURN_TO,
  TWITTER_CONNECTION_RETURN_TO,
  resolveFacebookConnectionReturn,
  resolveInstagramConnectionReturn,
  resolveTwitterConnectionReturn,
  settingsIntegrationsPath,
  settingsIntegrationsSearch,
} from "./settings-integrations";

describe("settings integrations deep links", () => {
  it("builds Settings Integrations search and path for each tab", () => {
    expect(settingsIntegrationsSearch("bookings")).toEqual({
      section: "integrations",
      integration: "bookings",
    });
    expect(settingsIntegrationsPath("automation")).toBe(
      "/settings?section=integrations&integration=automation",
    );
  });

  it("returns Instagram OAuth to the Integrations tab that started it", () => {
    expect(resolveInstagramConnectionReturn(INSTAGRAM_CONNECTION_RETURN_TO.social)).toEqual({
      to: "/settings",
      search: { section: "integrations", integration: "social" },
      label: "Back to Integrations",
    });
    expect(resolveInstagramConnectionReturn(INSTAGRAM_CONNECTION_RETURN_TO.automation)).toEqual({
      to: "/settings",
      search: { section: "integrations", integration: "automation" },
      label: "Back to Integrations",
    });
    expect(resolveInstagramConnectionReturn(INSTAGRAM_CONNECTION_RETURN_TO.autoDm)).toEqual({
      to: "/auto-dms/instagram",
      label: "Back to Instagram Auto DMs",
    });
    expect(resolveInstagramConnectionReturn(null)).toEqual({
      to: "/link",
      label: "Back to editor",
    });
  });

  it("returns X OAuth to the Integrations tab or Auto-DM page that started it", () => {
    expect(resolveTwitterConnectionReturn(TWITTER_CONNECTION_RETURN_TO.social)).toEqual({
      to: "/settings",
      search: { section: "integrations", integration: "social" },
      label: "Back to Integrations",
    });
    expect(resolveTwitterConnectionReturn(TWITTER_CONNECTION_RETURN_TO.automation)).toEqual({
      to: "/settings",
      search: { section: "integrations", integration: "automation" },
      label: "Back to Integrations",
    });
    expect(resolveTwitterConnectionReturn(TWITTER_CONNECTION_RETURN_TO.autoDm)).toEqual({
      to: "/auto-dms/twitter",
      label: "Back to X Auto DMs",
    });
    expect(resolveTwitterConnectionReturn(null)).toEqual({
      to: "/link",
      label: "Back to editor",
    });
  });

  it("returns Facebook OAuth to the Integrations tab or Auto-DM page that started it", () => {
    expect(resolveFacebookConnectionReturn(FACEBOOK_CONNECTION_RETURN_TO.social)).toEqual({
      to: "/settings",
      search: { section: "integrations", integration: "social" },
      label: "Back to Integrations",
    });
    expect(resolveFacebookConnectionReturn(FACEBOOK_CONNECTION_RETURN_TO.automation)).toEqual({
      to: "/settings",
      search: { section: "integrations", integration: "automation" },
      label: "Back to Integrations",
    });
    expect(resolveFacebookConnectionReturn(FACEBOOK_CONNECTION_RETURN_TO.autoDm)).toEqual({
      to: "/auto-dms/facebook",
      label: "Back to Facebook Auto DMs",
    });
    expect(resolveFacebookConnectionReturn(null)).toEqual({
      to: "/link",
      label: "Back to editor",
    });
  });
});
