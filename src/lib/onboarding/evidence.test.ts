import { expect, it } from "vitest";
import { onboardingProfile, onboardingStandout } from "./evidence";

it("includes available public professional fields without exposing credentials or inventing missing history", () => {
  const profile = onboardingProfile({
    id: "connection",
    provider: "linkedin",
    provider_handle: "Ari",
    provider_display_name: "Ari Shah",
    metadata: {
      profile: {
        headline: "Designer at Studio",
        company: "Studio",
        location: "London",
        bio: "Designing useful things",
        access_token: "secret",
        email: "private@example.com",
      },
      refresh_token: "secret",
    },
  });
  expect(profile).toMatchObject({
    name: "Ari Shah",
    headline: "Designer at Studio",
    company: "Studio",
    location: "London",
    biography: "Designing useful things",
    profileUrl: null,
  });
  expect(JSON.stringify(profile)).not.toMatch(/secret|private@example/);
  expect(onboardingProfile({ provider: "linkedin" }).company).toBe("");
});

it("only calls a post most engaged when observed metrics exist and preserves its comparison scope", () => {
  const base = {
    provider: "linkedin",
    caption: "A real imported post",
    remote_post_url: "https://www.linkedin.com/feed/update/123",
  };
  expect(
    onboardingStandout([
      { ...base, engagements: null },
      { ...base, engagements: 0 },
    ]),
  ).toBeNull();
  expect(
    onboardingStandout([
      { ...base, id: "a", engagements: 12 },
      { ...base, id: "b", engagements: 44 },
      { ...base, provider: "instagram", id: "c", engagements: 3 },
    ]),
  ).toMatchObject({ id: "b", engagements: 44, comparedPosts: 2 });
});

it("does not render unsafe media or destination URLs", () => {
  const profile = onboardingProfile({
    provider: "linkedin",
    provider_avatar_url: "javascript:alert(1)",
    metadata: { profile: { profile_url: "http://localhost/internal" } },
  });
  expect(profile.avatarUrl).toBeNull();
  expect(profile.profileUrl).toBeNull();
});
