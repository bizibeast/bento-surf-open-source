import { wantsLinkedInWritingSkill } from "./benny-linkedin-os";
import { expect, it } from "vitest";
import { BENNY_SKILLS } from "./benny-skills";

it("preloads a pinned LinkedIn workflow with strategy, CPIO, reviews and real publishing tools", () => {
  const skill = BENNY_SKILLS.find((skill) => skill.id === "linkedin-os");
  expect(skill).toBeDefined();
  expect(skill!.instructions).toMatch(/Convey[\s\S]*Package[\s\S]*Information[\s\S]*Order/);
  for (const section of [
    "40/40/20",
    "20 distinct",
    "PASS",
    "REVISE",
    "RETHINK",
    "weekly",
    "sample size",
    "one-off",
    "approval",
  ])
    expect(skill!.instructions.toLowerCase()).toContain(section.toLowerCase());
  for (const tool of [
    "get_content_brain",
    "get_analytics_workspace",
    "get_scheduler_workspace",
    "create_social_post",
  ])
    expect(skill!.tools).toContain(tool);
  expect(skill!.instructions).toContain("ad43ddeb0274002db521b5c47f7ff9570d52578d");
  expect(skill!.instructions).not.toMatch(
    /calendly|tryhattip|raw\.githubusercontent\.com|\/main\//i,
  );
  expect(skill!.instructions.length).toBeLessThan(12000);
});

it("selects only LinkedIn creative requests before appended named-agent context", () => {
  expect(wantsLinkedInWritingSkill("Write a LinkedIn post about my launch")).toBe(true);
  expect(wantsLinkedInWritingSkill("Start my LinkedIn strategy")).toBe(true);
  expect(
    wantsLinkedInWritingSkill(
      "Reconnect my LinkedIn account\nThis is the named head-of-content conversation. Use tools to prepare requested posts.",
    ),
  ).toBe(false);
  expect(wantsLinkedInWritingSkill("Write an Instagram post")).toBe(false);
  expect(wantsLinkedInWritingSkill({ request: "Write a LinkedIn post" })).toBe(false);
});
