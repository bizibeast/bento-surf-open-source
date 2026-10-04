import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrations = resolve(process.cwd(), "supabase/migrations");
const migrationName = readdirSync(migrations).find((name) =>
  name.endsWith("_content_knowledge_sources.sql"),
);
const sql = migrationName ? readFileSync(resolve(migrations, migrationName), "utf8") : "";
const allSql = readdirSync(migrations)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(resolve(migrations, name), "utf8"))
  .join("\n");

describe("Content knowledge source migration", () => {
  it("creates owner-isolated idempotent source records", () => {
    expect(migrationName).toBeTruthy();
    expect(sql).toContain("create table public.content_source_records");
    expect(sql).toContain("unique (connection_id, external_item_id)");
    expect(sql).toContain("content_source_records_owner_all");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("integration");
  });

  it("keeps OAuth state metadata service-only", () => {
    expect(sql).toContain("alter table public.content_connection_states");
    expect(sql).toContain("metadata jsonb");
    expect(sql).toContain(
      "revoke all on public.content_connection_states from public, anon, authenticated",
    );
  });

  it("indexes the composite connection ownership foreign key", () => {
    expect(allSql).toContain("content_source_records_connection_owner_idx");
    expect(allSql).toMatch(
      /content_source_records_connection_owner_idx[\s\S]*\(connection_id,\s*user_id\)/i,
    );
  });
});
