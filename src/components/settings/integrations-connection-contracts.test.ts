import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const socialConnect = readFileSync(
  resolve(process.cwd(), "src/components/settings/SocialAccountsConnect.tsx"),
  "utf8",
);
const autoDmConnect = readFileSync(
  resolve(process.cwd(), "src/components/settings/InstagramAutoDmConnect.tsx"),
  "utf8",
);
const facebookAutoDmConnect = readFileSync(
  resolve(process.cwd(), "src/components/settings/FacebookAutoDmConnect.tsx"),
  "utf8",
);
const twitterAutoDmConnect = readFileSync(
  resolve(process.cwd(), "src/components/settings/TwitterAutoDmConnect.tsx"),
  "utf8",
);
const overview = readFileSync(
  resolve(process.cwd(), "src/components/settings/IntegrationsOverview.tsx"),
  "utf8",
);
const bookingConnect = readFileSync(
  resolve(process.cwd(), "src/components/settings/BookingAccountsConnect.tsx"),
  "utf8",
);
const bookingPage = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/calendar.tsx"),
  "utf8",
);

describe("Settings Integrations connection contracts", () => {
  it("starts Instagram OAuth with the same full-scope intent from Social and Auto-DM", () => {
    expect(socialConnect).toContain('beginInstagramConnection({ data: { intent: "scheduler" } })');
    expect(autoDmConnect).toContain('beginInstagramConnection({ data: { intent: "scheduler" } })');
    expect(autoDmConnect).not.toContain('intent: "auto_dm"');
  });

  it("tells creators one Instagram login covers scheduling and Auto DMs", () => {
    expect(socialConnect).not.toContain("One login covers scheduling and Auto DMs.");
    expect(autoDmConnect).toContain("One Instagram login powers Auto DMs and Social scheduling.");
    expect(overview).toContain('label: "Instagram DMs"');
  });

  it("starts X OAuth from Social and Auto-DM with Direct Message scopes in one login", () => {
    expect(socialConnect).toContain("beginSocialConnection({ data: { provider } })");
    expect(twitterAutoDmConnect).toContain(
      'beginSocialConnection({ data: { provider: "twitter" } })',
    );
    expect(twitterAutoDmConnect).toContain("One X login powers Auto DMs and Social scheduling.");
    expect(overview).toContain('label: "X DMs"');
  });

  it("starts Facebook OAuth from Social and Auto-DM with Messenger scopes in one login", () => {
    expect(socialConnect).toContain("beginSocialConnection({ data: { provider } })");
    expect(facebookAutoDmConnect).toContain(
      'beginSocialConnection({ data: { provider: "facebook" } })',
    );
    expect(facebookAutoDmConnect).toContain(
      "One Facebook login powers Auto DMs and Social scheduling.",
    );
    expect(overview).toContain('label: "Facebook DMs"');
  });

  it("keeps Google Calendar and Fathom connect actions on the Integrations page", () => {
    expect(overview).toContain("BookingAccountsConnect");
    expect(bookingConnect).toContain("beginGoogleCalendarConnection");
    expect(bookingConnect).toContain("beginFathomConnection");
    expect(bookingConnect).toContain("disconnectBookingConnection");
    expect(bookingConnect).toContain("setDefaultBookingConnection");
  });

  it("keeps Calendar connection summaries consistent with Integrations", () => {
    expect(bookingPage).toContain("BookingProviderMark");
    expect(bookingPage).toContain("<Switch");
    expect(bookingPage).toContain('integration="bookings"');
  });
});
