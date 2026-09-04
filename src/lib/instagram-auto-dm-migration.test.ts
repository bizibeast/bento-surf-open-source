import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260730052206_instagram_auto_dm_durable_runs.sql"),
  "utf8",
).toLowerCase();
const emailMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260730054257_instagram_auto_dm_email_capture.sql"),
  "utf8",
).toLowerCase();
const healthRotationMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260730094349_rotate_instagram_health_audits.sql"),
  "utf8",
).toLowerCase();
const deletionMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260730133227_instagram_data_deletion_compliance.sql",
  ),
  "utf8",
).toLowerCase();
const deliveryLeaseMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260731030103_harden_instagram_dm_delivery_leases.sql",
  ),
  "utf8",
).toLowerCase();
const privateReplyConfirmationMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260731181500_instagram_private_reply_text_confirmation.sql",
  ),
  "utf8",
).toLowerCase();
const runIndexMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260731190000_instagram_dm_run_foreign_key_indexes.sql",
  ),
  "utf8",
).toLowerCase();
const deliveryPacingMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260801090000_instagram_delivery_pacing.sql"),
  "utf8",
).toLowerCase();
const ownerIntegrityMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260801100000_instagram_owner_integrity.sql"),
  "utf8",
).toLowerCase();
const commentReconciliationMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260801113000_instagram_comment_reconciliation.sql"),
  "utf8",
).toLowerCase();
const timestampRepairMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260801130000_fix_instagram_timestamp_variables.sql",
  ),
  "utf8",
).toLowerCase();
const eventClaimRepairMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260801163000_fix_instagram_event_claim_single_result.sql",
  ),
  "utf8",
).toLowerCase();
const serverSource = readFileSync(
  resolve(process.cwd(), "src/lib/instagram-auto-dm.server.ts"),
  "utf8",
);
const followGateMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260820143000_auto_dm_single_action_follow_gate.sql",
  ),
  "utf8",
).toLowerCase();

describe("Instagram Auto-DM durable workflow migrations", () => {
  it("keeps follower rechecks bounded, sender-bound, and service-only", () => {
    expect(followGateMigration).toContain("follow_recheck_count between 0 and follow_max_rechecks");
    expect(followGateMigration).toContain("run.sender_id_hash = p_sender_id_hash");
    expect(followGateMigration).toContain(
      "run.status = 'awaiting_follow' and run.follow_recheck_count < run.follow_max_rechecks",
    );
    expect(followGateMigration).toContain(
      "when run.follow_event_id = p_follow_event_id then run.follow_recheck_count",
    );
    expect(followGateMigration).toContain(
      "revoke all on function public.claim_instagram_dm_follow_recheck",
    );
    expect(followGateMigration).toContain("to service_role");
  });
  it("keeps workflow state service-only and sender-bound", () => {
    expect(runMigration).toContain(
      "alter table public.instagram_dm_runs enable row level security",
    );
    expect(runMigration).toContain(
      "revoke all on public.instagram_dm_runs from public, anon, authenticated",
    );
    expect(runMigration).toContain("grant all on public.instagram_dm_runs to service_role");
    expect(runMigration).toContain("sender_id_hash");
    expect(runMigration).not.toContain("sender_id text");
    expect(runMigration).toContain("set search_path = ''");
    expect(emailMigration).toContain("set search_path = ''");
  });

  it("claims confirmation and email events atomically with bounded retries", () => {
    expect(runMigration).toContain("update public.instagram_dm_runs run");
    expect(runMigration).toContain("returning run.* into claimed_run");
    expect(runMigration).toContain("run.attempt_count < 9");
    expect(emailMigration).toContain("for update skip locked");
    expect(emailMigration).toContain("run.attempt_count < 9");
    expect(emailMigration).toContain("run.email_event_id = p_email_event_id");
    expect(privateReplyConfirmationMigration).toContain("for update of run skip locked");
    expect(privateReplyConfirmationMigration).toContain("run.attempt_count < 9");
    expect(privateReplyConfirmationMigration).toContain(
      "run.quick_reply_prompt_response_id is null",
    );
  });

  it("restricts suggested-reply prompt claims to the service role", () => {
    expect(privateReplyConfirmationMigration).toContain("set search_path = ''");
    expect(privateReplyConfirmationMigration).toContain(
      "revoke all on function public.claim_instagram_dm_run_for_quick_reply_prompt",
    );
    expect(privateReplyConfirmationMigration).toContain(
      "grant execute on function public.claim_instagram_dm_run_for_quick_reply_prompt",
    );
    expect(privateReplyConfirmationMigration).toContain("to service_role");
  });

  it("indexes durable-run foreign keys used by workflow history and cleanup", () => {
    expect(runIndexMigration).toContain("instagram_dm_runs_automation_idx");
    expect(runIndexMigration).toContain("on public.instagram_dm_runs(automation_id)");
    expect(runIndexMigration).toContain("instagram_dm_runs_audience_contact_idx");
    expect(runIndexMigration).toContain("on public.instagram_dm_runs(audience_contact_id)");
  });

  it("restricts email capture RPCs to the service role", () => {
    expect(emailMigration).toContain("revoke all on function public.claim_instagram_dm_email_run");
    expect(emailMigration).toContain(
      "grant execute on function public.claim_instagram_dm_email_run",
    );
    expect(emailMigration).toContain(
      "revoke all on function public.capture_instagram_dm_email_audience",
    );
    expect(emailMigration).toContain(
      "grant execute on function public.capture_instagram_dm_email_audience",
    );
    expect(emailMigration).toContain("to service_role");
  });

  it("uses a crash-recovery lease longer than the outbound Meta timeout", () => {
    expect(deliveryLeaseMigration.match(/interval '2 minutes'/g)).toHaveLength(3);
    expect(deliveryLeaseMigration).not.toContain("interval '20 seconds'");
    expect(deliveryLeaseMigration).toContain(
      "create or replace function public.claim_instagram_dm_event",
    );
    expect(deliveryLeaseMigration).toContain(
      "create or replace function public.claim_instagram_dm_run",
    );
    expect(deliveryLeaseMigration).toContain(
      "create or replace function public.claim_instagram_dm_email_run",
    );
    expect(deliveryLeaseMigration.match(/set search_path = ''/g)).toHaveLength(3);
    expect(deliveryLeaseMigration.match(/from public, anon, authenticated/g)).toHaveLength(3);
    expect(deliveryLeaseMigration.match(/to service_role/g)).toHaveLength(3);
  });

  it("paces concurrent provider deliveries per account without exposing runtime state", () => {
    expect(deliveryPacingMigration).toContain("create table public.instagram_delivery_slots");
    expect(deliveryPacingMigration).toContain("for update");
    expect(deliveryPacingMigration).toContain("greatest(");
    expect(deliveryPacingMigration).toContain("set search_path = ''");
    expect(deliveryPacingMigration).toContain(
      "revoke all on public.instagram_delivery_slots from public, anon, authenticated",
    );
    expect(deliveryPacingMigration).toContain(
      "grant execute on function public.claim_instagram_delivery_slot",
    );
    expect(deliveryPacingMigration).toContain(
      "grant execute on function public.defer_instagram_delivery_slot",
    );
    expect(deliveryPacingMigration.match(/to service_role/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("uses unambiguous timestamptz variables in database-side pacing and recovery", () => {
    expect(timestampRepairMigration).toContain("v_now timestamptz := clock_timestamp()");
    expect(timestampRepairMigration).not.toMatch(/\bcurrent_time\s+timestamptz/);
    expect(timestampRepairMigration).toContain(
      "create or replace function public.claim_instagram_delivery_slot",
    );
    expect(timestampRepairMigration).toContain(
      "create or replace function public.defer_instagram_delivery_slot",
    );
    expect(timestampRepairMigration).toContain(
      "create or replace function public.claim_instagram_comment_reconciliations",
    );
    expect(timestampRepairMigration.match(/set search_path = ''/g)).toHaveLength(3);
    expect(timestampRepairMigration.match(/from public, anon, authenticated/g)).toHaveLength(3);
    expect(timestampRepairMigration.match(/to service_role/g)).toHaveLength(3);
  });

  it("returns exactly one decision for a duplicate Instagram event claim", () => {
    expect(eventClaimRepairMigration).toContain(
      "create or replace function public.claim_instagram_dm_event",
    );
    expect(eventClaimRepairMigration).toMatch(
      /return query select claimed_id, false;\s+return;\s+end if;/,
    );
    expect(eventClaimRepairMigration).toContain("set search_path = ''");
    expect(eventClaimRepairMigration).toContain(
      "revoke all on function public.claim_instagram_dm_event",
    );
    expect(eventClaimRepairMigration).toContain("to service_role");
  });

  it("enforces creator and connection ownership for all durable Instagram workflow state", () => {
    expect(ownerIntegrityMigration).toContain("enforce_instagram_automation_owner");
    expect(ownerIntegrityMigration).toContain("connection.user_id = new.user_id");
    expect(ownerIntegrityMigration).toContain("connection.provider = 'instagram'");
    expect(ownerIntegrityMigration).toContain("enforce_instagram_run_owner");
    expect(ownerIntegrityMigration).toContain("automation.connection_id = new.connection_id");
    expect(ownerIntegrityMigration).toContain("automation.user_id = new.user_id");
    expect(ownerIntegrityMigration).toContain("enforce_instagram_event_connection");
    expect(ownerIntegrityMigration.match(/set search_path = ''/g)).toHaveLength(3);
    expect(ownerIntegrityMigration.match(/from public, anon, authenticated/g)).toHaveLength(3);
    expect(ownerIntegrityMigration.match(/to service_role/g)).toHaveLength(3);
  });

  it("leases missed-comment reconciliation atomically and only to the service role", () => {
    expect(commentReconciliationMigration).toContain(
      "create or replace function public.claim_instagram_comment_reconciliations",
    );
    expect(commentReconciliationMigration).toContain("for update of connection skip locked");
    expect(commentReconciliationMigration).toContain("set search_path = ''");
    expect(commentReconciliationMigration).toContain(
      "revoke all on function public.claim_instagram_comment_reconciliations",
    );
    expect(commentReconciliationMigration).toContain("from public, anon, authenticated");
    expect(commentReconciliationMigration).toContain(
      "grant execute on function public.claim_instagram_comment_reconciliations",
    );
    expect(commentReconciliationMigration).toContain("to service_role");
    expect(commentReconciliationMigration).toContain(
      "automation.trigger_type in ('comment_keyword', 'any_comment')",
    );
  });

  it("rotates provider health audits without exposing connection secrets", () => {
    expect(healthRotationMigration).toContain(
      "add column if not exists last_health_check_at timestamptz",
    );
    expect(healthRotationMigration).toContain("social_connections_instagram_health_check_idx");
    expect(healthRotationMigration).toContain("where provider = 'instagram' and status = 'active'");
    expect(healthRotationMigration).toContain(
      "revoke all on public.social_connections from anon, authenticated",
    );
    expect(healthRotationMigration).toContain(
      "grant all on public.social_connections to service_role",
    );
    expect(serverSource).toContain(
      ".or(`last_health_check_at.is.null,last_health_check_at.lt.${retryCutoff}`)",
    );
    expect(serverSource).toContain(
      '.order("last_health_check_at", { ascending: true, nullsFirst: true })',
    );
    expect(serverSource).toContain(".update({ last_health_check_at: now.toISOString() })");
  });

  it("purges Meta account data atomically and keeps deletion proofs service-only", () => {
    const deletionTableDefinition = deletionMigration.split(
      "create or replace function public.purge_instagram_account_data",
      1,
    )[0];
    expect(deletionMigration).toContain(
      "alter table public.instagram_data_deletion_requests enable row level security",
    );
    expect(deletionMigration).toContain(
      "revoke all on public.instagram_data_deletion_requests from public, anon, authenticated",
    );
    expect(deletionMigration).toContain(
      "grant all on public.instagram_data_deletion_requests to service_role",
    );
    expect(deletionMigration).toContain("delete from public.instagram_dm_events");
    expect(deletionMigration).toContain("event.instagram_account_id = p_provider_user_id");
    expect(deletionMigration).toContain("delete from public.social_connections");
    expect(deletionTableDefinition).not.toContain("provider_user_id text");
    expect(deletionMigration).toContain("provider_user_id_hash text");
    expect(deletionMigration).toContain("set search_path = ''");
    expect(deletionMigration).toContain(
      "revoke all on function public.purge_instagram_account_data",
    );
    expect(deletionMigration).toContain(
      "grant execute on function public.purge_instagram_account_data",
    );
    expect(deletionMigration).toContain("to service_role");
  });
});
