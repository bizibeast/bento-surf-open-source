import { describe, expect, it } from "vitest";
import sql from "../../supabase/migrations/20260919090000_content_telegram_integration.sql?raw";

describe("Telegram Content integration migration", () => {
  it("owns connections and protects service-only delivery tables", () => {
    expect(sql).toContain("create table public.content_connections");
    expect(sql).toContain("unique (user_id, provider, external_account_id)");
    expect(sql).toContain("content_connections_telegram_chat_unique");
    expect(sql).toContain("create table public.content_connection_states");
    expect(sql).toContain("create table public.telegram_update_receipts");
    expect(sql).toContain("create table public.telegram_actions");
    expect(sql).toContain("content_connections_owner_all");
    expect(sql).toContain(
      "revoke all on public.telegram_update_receipts from public, anon, authenticated",
    );
  });

  it("leases updates and claims actions at most once", () => {
    expect(sql).toContain("claim_telegram_update");
    expect(sql).toContain("lease_expires_at");
    expect(sql).toContain("finish_telegram_update");
    expect(sql).toContain("claim_telegram_action");
    expect(sql).toContain("consumed_at is null");
  });
});
