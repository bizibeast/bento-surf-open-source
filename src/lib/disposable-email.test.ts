import { describe, expect, it } from "vitest";
import { isDisposableOrTestEmail } from "./disposable-email";

describe("disposable and test inboxes", () => {
  it.each([
    "stan@yopmail.com",
    "heteyot236@caps7.com",
    "a@mailinator.com",
    "a@guerrillamail.com",
    "a@10minutemail.com",
    "a@temp-mail.org",
    "a@sharklasers.com",
    "a@mail.yopmail.com",
    "fixture@example.invalid",
    "qa@example.test",
    "person@example.com",
  ])("skips %s", (email) => {
    expect(isDisposableOrTestEmail(email)).toBe(true);
  });

  it("skips plus-address test tags and keeps ordinary aliases", () => {
    expect(isDisposableOrTestEmail("owner+googleoauthreview@gmail.com")).toBe(true);
    expect(isDisposableOrTestEmail("owner+bento-cancel-qa2-20261014@gmail.com")).toBe(true);
    expect(isDisposableOrTestEmail("owner+test@gmail.com")).toBe(true);
    expect(isDisposableOrTestEmail("owner+newsletter@gmail.com")).toBe(false);
    expect(isDisposableOrTestEmail("Owner@Gmail.com")).toBe(false);
  });
});
