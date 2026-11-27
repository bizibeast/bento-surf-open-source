import { describe, expect, it, vi } from "vitest";
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
import { secondaryCommerceIntakeError } from "./commerce-growth.server";
const id = "b03eb0aa-a8fb-4800-bf72-8b854c680385";
function settings(required: boolean) {
  return {
    website: {
      sections: [
        {
          id: "intake",
          title: "Your details",
          body: "",
          buyerQuestions: [{ id, question: "What is your goal?", required }],
        },
      ],
    },
  };
}

describe("secondary commerce offer intake policy", () => {
  it("allows offers without intake and offers whose section questions are all optional", () => {
    expect(secondaryCommerceIntakeError({ kind: "course", settings: {} })).toBeNull();
    expect(
      secondaryCommerceIntakeError({ kind: "digital_product", settings: settings(false) }),
    ).toBeNull();
  });
  it("requires separate purchase when any section question needs an answer", () => {
    expect(secondaryCommerceIntakeError({ kind: "course", settings: settings(true) })).toMatch(
      /required buyer questions.*separately/,
    );
  });
  it("uses the canonical legacy/custom boundary rather than reviving stale legacy fields for other kinds", () => {
    const legacy = { buyerQuestions: ["What should I make?"] };
    expect(secondaryCommerceIntakeError({ kind: "custom_product", settings: legacy })).toMatch(
      /required buyer questions/,
    );
    expect(secondaryCommerceIntakeError({ kind: "course", settings: legacy })).toBeNull();
  });
  it("requires a direct purchase for the mandatory priority-message body", () => {
    expect(secondaryCommerceIntakeError({ kind: "priority_dm", settings: {} })).toMatch(
      /Priority messages.*separately/,
    );
  });
  it("rejects malformed question definitions instead of silently interpreting them as optional", () => {
    const malformed = {
      website: {
        sections: [
          { buyerQuestions: [{ id: "invalid", question: "Required intake", required: "yes" }] },
        ],
      },
    };
    expect(secondaryCommerceIntakeError({ kind: "course", settings: malformed })).toMatch(
      /invalid buyer questions/,
    );
  });
});
