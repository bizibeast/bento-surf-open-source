import { describe, expect, it } from "vitest";
import { publicCalendarHead } from "./public-calendar-seo";

const calendar = {
  profile: {
    username: "coach",
    displayName: "Creator Coach",
    avatarUrl: "/cdn/coach.webp",
  },
  pages: [{ name: "Work with me", system: "calendar" }],
  sessions: [
    {
      slug: "strategy-call",
      title: "Strategy call",
      subtitle: "A focused planning session.",
      durationMinutes: 60,
    },
  ],
};

describe("public calendar SEO", () => {
  it("adds canonical and social metadata for the creator calendar", () => {
    const head = publicCalendarHead(calendar, "https://public.example");
    expect(head.links).toContainEqual({
      rel: "canonical",
      href: "https://public.example/@coach/calendar",
    });
    expect(head.meta).toContainEqual({
      property: "og:url",
      content: "https://public.example/@coach/calendar",
    });
    expect(head.meta).toContainEqual({
      property: "og:image",
      content: "https://public.example/cdn/coach.webp",
    });
  });

  it("uses the shared default preview when the creator has no avatar", () => {
    const head = publicCalendarHead(
      {
        ...calendar,
        profile: { ...calendar.profile, avatarUrl: null },
      },
      "https://public.example",
    );

    expect(head.meta).toContainEqual({
      property: "og:image",
      content: "https://public.example/branding/bento-logo.png?v=20260813",
    });
  });

  it("describes only the real bookable sessions shown on the page", () => {
    const head = publicCalendarHead(calendar, "https://public.example");
    const schema = JSON.parse(head.scripts[0].children);
    expect(schema).toMatchObject({
      "@type": "CollectionPage",
      name: "Work with me - Creator Coach",
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 1,
        itemListElement: [
          {
            position: 1,
            item: {
              "@type": "Service",
              duration: "PT60M",
              url: "https://public.example/@coach/products/strategy-call",
            },
          },
        ],
      },
    });
  });

  it("inherits creator search visibility", () => {
    const head = publicCalendarHead(
      {
        ...calendar,
        profile: { ...calendar.profile, noindex: true },
      },
      "https://public.example",
    );

    expect(head.meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });
  });
});
