import migration from "../../supabase/migrations/20260819210000_referral_financial_foundation.sql?raw";
import dataMigration from "../../supabase/migrations/20260819211000_referral_account_backfill.sql?raw";
import serverSource from "../server.ts?raw";
import webhookSource from "../integrations/dodo/webhook.server.ts?raw";
import referralServerSource from "./referral.server.ts?raw";
import referralFunctionsSource from "./referral.functions.ts?raw";
import referralWorkerSource from "./referral-worker.server.ts?raw";
import referralAdminSource from "./referral-admin.functions.ts?raw";
import commerceFunctionsSource from "./commerce.functions.ts?raw";
import { describe, expect, it } from "vitest";

describe("referral financial foundation migration", () => {
  it("creates every ledger with RLS and service-only writes", () => {
    for (const table of [
      "referral_program_settings",
      "referral_accounts",
      "referral_clicks",
      "referral_attributions",
      "referral_payment_effects",
      "referral_commissions",
      "referral_commission_adjustments",
      "referral_payouts",
      "referral_reach_submissions",
      "referral_admin_audit_events",
    ]) {
      expect(migration).toContain(`public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration).toContain("revoke all on public.referral_accounts from anon, authenticated");
  });

  it("makes attribution, commissions, refunds, and payout claims atomic", () => {
    expect(migration).toContain("consume_referral_click");
    expect(migration).toContain("accrue_referral_commission");
    expect(migration).toContain("record_referral_payment_effect");
    expect(migration).toContain("apply_referral_refund");
    expect(migration).toContain("request_referral_payout");
    expect(migration).toContain("referral_admin_audit_immutable");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("commission_ids uuid[]");
    expect(migration).toContain("reach_ids uuid[]");
    expect(migration).toContain("adjustment_ids uuid[]");
    expect(migration).toContain("where id = any(commission_ids)");
    expect(migration).toContain("where id = any(reach_ids)");
    expect(migration).toContain("where id = any(adjustment_ids)");
    expect(migration).toContain("on conflict do nothing");
  });

  it("snapshots reach policy and preserves paid reach state", () => {
    expect(migration).toContain("referral_url_snapshot text not null");
    expect(migration).toContain("rate_per_10k integer not null");
    expect(migration).toContain("reward_cap integer not null");
    expect(migration).toContain("update public.referral_reach_submissions set status = 'paid'");
    expect(referralFunctionsSource).toContain("referral_url_snapshot: referralUrl");
    expect(referralWorkerSource).toContain("submission.rate_per_10k");
    expect(referralWorkerSource).toContain("submission.reward_cap");
  });

  it("keeps founder financial mutations in audited database transactions", () => {
    for (const rpc of [
      "admin_set_referral_account_status",
      "admin_set_referral_account_rate",
      "admin_transition_referral_payout",
      "admin_review_referral_reach",
      "admin_update_referral_settings",
    ]) {
      expect(migration).toContain(`function public.${rpc}`);
      expect(referralAdminSource).toContain(`"${rpc}"`);
    }
    expect(referralAdminSource).not.toContain("async function audit(");
  });

  it("uses integer money, basis points, and unique provider effects", () => {
    expect(migration).toContain("commission_rate_bps integer");
    expect(migration).toContain("amount integer");
    expect(migration).toContain("payment_id text not null unique");
    expect(migration).toContain("refund_id text not null unique");
  });

  it("keeps account backfill separate and deterministic", () => {
    expect(dataMigration).toContain("insert into public.referral_accounts");
    expect(dataMigration).toContain("from public.profiles");
    expect(dataMigration).toContain("on conflict (user_id) do nothing");
  });

  it("handles referral links before public caching without an open redirect", () => {
    expect(serverSource.indexOf("handleReferralRedirect(request)")).toBeLessThan(
      serverSource.indexOf("readPublicPageCache(request, env)"),
    );
    expect(referralServerSource).toContain('new URL("/signup", appUrl)');
    expect(referralServerSource).toContain('request.headers.get("cf-connecting-ip")');
    expect(referralServerSource).not.toContain("redirect_uri");
    expect(referralServerSource).toContain('"HttpOnly"');
    expect(referralServerSource).toContain('"SameSite=Lax"');
    expect(migration).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("code not in ('admin', 'api'");
  });

  it("retains transient attribution cookies and sends exhausted verification to the DLQ", () => {
    expect(
      referralFunctionsSource.indexOf('if (error) throw new Error("Referral attribution'),
    ).toBeLessThan(referralFunctionsSource.lastIndexOf("clearCookie();"));
    expect(serverSource).not.toContain("if (message.attempts >= 5) message.ack()");
  });

  it("connects only recognized successful Bento payments and refunds to the ledger", () => {
    expect(webhookSource).toContain('"record_referral_payment_effect"');
    expect(webhookSource).toContain("p_product_eligible: Boolean(planFromEvent(event.data))");
    expect(referralWorkerSource).toContain('.from("referral_payment_effects")');
    expect(referralWorkerSource).toContain('.eq("eligible", true)');
    expect(webhookSource).toContain('"apply_referral_refund" as never');
  });

  it("does not let verification workers overwrite a founder decision", () => {
    expect(referralWorkerSource.match(/\.eq\("status", submission\.status\)/g)).toHaveLength(3);
  });

  it("routes legacy Store affiliate blocks through the canonical referral account", () => {
    expect(commerceFunctionsSource).toContain('.from("referral_accounts")');
    expect(commerceFunctionsSource).toContain("`${publicAppUrl()}/r/${encodeURIComponent");
    expect(commerceFunctionsSource).not.toContain("/signup?ref=");
  });
});
