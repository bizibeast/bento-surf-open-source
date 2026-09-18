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
    const head = publicCalendarHead(calendar);
    expect(head.links).toContainEqual({
      rel: "canonical",
      href: "http://localhost:8080/@coach/calendar",
    });
    expect(head.meta).toContainEqual({
      property: "og:url",
      content: "http://localhost:8080/@coach/calendar",
    });
    expect(head.meta).toContainEqual({
      property: "og:image",
      content: "http://localhost:8080/cdn/coach.webp",
    });
  });

  it("describes only the real bookable sessions shown on the page", () => {
    const head = publicCalendarHead(calendar);
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
              url: "http://localhost:8080/@coach/products/strategy-call",
            },
          },
        ],
      },
    });
  });

  it("inherits creator search visibility", () => {
    const head = publicCalendarHead({
      ...calendar,
      profile: { ...calendar.profile, noindex: true },
    });

    expect(head.meta).toContainEqual({
      name: "robots",
      content: "noindex, nofollow, noarchive",
    });
  });
});
