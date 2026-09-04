import { afterEach, describe, expect, it, vi } from "vitest";
import { fathomRedirectUri } from "@/lib/booking-fathom.server";
import { googleCalendarRedirectUri } from "@/lib/booking-google.server";
import { instagramRedirectUri } from "@/lib/social-connections.functions";
import { socialProviderRedirectUri } from "@/lib/social-oauth.functions";
import { polarRedirectUri } from "./polar/client.server";
import { stripeRedirectUri } from "./stripe/client.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  ["production", "https://app.bento.surf"],
  ["staging", "https://app.test.bento.surf"],
])("%s integration callbacks", (_environment, appOrigin) => {
  it("uses the application host for payment and booking OAuth callbacks", () => {
    vi.stubEnv("VITE_APP_URL", `${appOrigin}/`);

    expect(polarRedirectUri()).toBe(`${appOrigin}/integrations/polar/callback`);
    expect(stripeRedirectUri()).toBe(`${appOrigin}/integrations/stripe/callback`);
    expect(googleCalendarRedirectUri()).toBe(`${appOrigin}/integrations/calendar/google/callback`);
    expect(fathomRedirectUri()).toBe(`${appOrigin}/integrations/fathom/callback`);
  });

  it("uses the application host for social OAuth callbacks", () => {
    vi.stubEnv("VITE_APP_URL", appOrigin);
    vi.stubEnv("META_INSTAGRAM_REDIRECT_URI", "");

    expect(instagramRedirectUri()).toBe(`${appOrigin}/integrations/instagram/callback`);
    expect(socialProviderRedirectUri("youtube")).toBe(
      `${appOrigin}/integrations/social/youtube/callback`,
    );
    expect(socialProviderRedirectUri("twitter")).toBe(
      `${appOrigin}/integrations/social/twitter/callback`,
    );
  });
});
