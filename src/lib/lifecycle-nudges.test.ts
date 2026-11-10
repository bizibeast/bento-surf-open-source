import { describe, expect, it } from "vitest";
import { DISPOSABLE_EMAIL_DOMAINS } from "./disposable-email";
import {
  lifecycleNudgeInboxKey,
  lifecycleNudgeRecipient,
  lifecycleNudgeSendDecision,
} from "./lifecycle-nudges";
import migration from "../../supabase/migrations/20261104091000_lifecycle_nudge_once_per_inbox.sql?raw";

const aliasA = "samplecreator+bento-onb-a-20261024@gmail.com";
const aliasB = "SampleCreator+Bento-Onb-B-20261024@Gmail.com";

describe("lifecycle nudge recipient", () => {
  it("keeps the account address, including plus-tags", () => {
    expect(lifecycleNudgeRecipient(` ${aliasB} `)).toBe(aliasB.toLowerCase());
    expect(lifecycleNudgeRecipient(aliasA)).toBe(aliasA);
    expect(lifecycleNudgeRecipient("owner+newsletter@fastmail.com")).toBe(
      "owner+newsletter@fastmail.com",
    );
  });

  it("skips disposable domains, test plus-tags, and the internal review inbox", () => {
    expect(lifecycleNudgeRecipient("stan@yopmail.com")).toBeNull();
    expect(lifecycleNudgeRecipient("owner+qa2@gmail.com")).toBeNull();
    expect(lifecycleNudgeRecipient("owner+googleoauthreview@gmail.com")).toBeNull();
    expect(lifecycleNudgeRecipient("owner+stgfix1025a@mail.grokbot.com")).toBeNull();
    expect(lifecycleNudgeRecipient("not-an-email")).toBeNull();
  });
});

describe("lifecycle nudge eligibility", () => {
  it("collapses Gmail dots and plus-tags but keeps other providers' full addresses", () => {
    expect(lifecycleNudgeInboxKey(aliasA)).toBe("samplecreator@gmail.com");
    expect(lifecycleNudgeInboxKey(" Sample.Creator+x@Googlemail.com ")).toBe(
      "samplecreator@gmail.com",
    );
    expect(lifecycleNudgeInboxKey(" Person.Name+news@Fastmail.com ")).toBe(
      "person.name+news@fastmail.com",
    );
    expect(lifecycleNudgeInboxKey("invalid")).toBeNull();
    expect(lifecycleNudgeInboxKey("...+tag@gmail.com")).toBeNull();
  });

  it("suppresses sandbox nudges and normalizes production recipients", () => {
    expect(lifecycleNudgeSendDecision({ recipientEmail: aliasA, mode: "sandbox" })).toEqual({
      action: "suppress",
      reason: "Lifecycle nudges are not sent in sandbox.",
    });
    expect(
      lifecycleNudgeSendDecision({ recipientEmail: ` ${aliasB} `, mode: "production" }),
    ).toEqual({
      action: "send",
      recipient: aliasB.toLowerCase(),
    });
    for (const recipientEmail of ["owner+qa@gmail.com", "person@yopmail.com", "invalid"]) {
      expect(lifecycleNudgeSendDecision({ recipientEmail, mode: "production" })).toEqual({
        action: "suppress",
        reason: "Test, disposable, or invalid inbox.",
      });
    }
  });
});

describe("lifecycle nudge migration", () => {
  it("runs after the latest migration and safely dedupes before indexing", () => {
    const paths = Object.keys(
      import.meta.glob("../../supabase/migrations/*_lifecycle_nudge_once_per_inbox.sql"),
    );
    expect(paths).toHaveLength(1);
    expect(Number(paths[0].match(/(\d{14})_/)![1])).toBeGreaterThan(20261103083000);
    expect(migration).toContain(
      "create unique index if not exists email_outbox_lifecycle_nudge_inbox_key",
    );
    expect(migration).toContain(
      "on public.email_outbox (event_type, public.lifecycle_nudge_inbox_key(recipient_email))",
    );
    expect(migration).toContain(
      "where event_type in ('onboarding_quick_win','commerce_feature','pro_upgrade') and status <> 'suppressed';",
    );
    expect(migration.indexOf("update public.email_outbox")).toBeLessThan(
      migration.indexOf("create unique index"),
    );
    expect(migration).toContain("row_number() over");
    expect(migration).toContain("coalesce(sent_at, created_at), id");
    expect(migration).not.toMatch(/delete from public\.email_outbox/i);
    const enqueue = migration.slice(
      migration.indexOf("create or replace function public.enqueue_due_lifecycle_emails()"),
    );
    expect(enqueue).toContain(") due\n  on conflict do nothing;");
    expect(enqueue).not.toContain("on conflict (event_key)");
    expect(migration).not.toMatch(/weekly_digest|weekly-digest/);
    for (const signature of [
      "lifecycle_nudge_inbox_key(text)",
      "is_disposable_or_test_email(text)",
      "enqueue_due_lifecycle_emails()",
    ]) {
      expect(migration).toContain(
        `revoke all on function public.${signature} from public, anon, authenticated`,
      );
      expect(migration).toContain(`grant execute on function public.${signature} to service_role`);
    }
    expect(migration.match(/grant execute[^;]+;/g)).toHaveLength(3);
  });

  it("queues one step per inbox and skips the same disposable domains", () => {
    expect(migration).toContain("function public.lifecycle_nudge_inbox_key(text)");
    expect(migration).toContain("function public.is_disposable_or_test_email(text)");
    expect(migration).toContain("distinct on (inbox_key, event_type)");
    expect(migration).toContain("lower(auth_user.email)");
    expect(migration).not.toContain("split_part(lower(auth_user.email), '+', 1)");
    for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
      expect(migration).toContain(`'${domain}'`);
    }
    expect(migration).toContain(
      "grant execute on function public.enqueue_due_lifecycle_emails() to service_role",
    );
  });
});
