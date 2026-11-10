import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const image = "postgres:16-alpine";
const container = `meta-dm-reliability-${process.pid}`;

function dockerAvailable() {
  return (
    spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 &&
    spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0
  );
}

function psql(sql: string) {
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-tA", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8" },
  ).trim();
}

describe("Meta Auto-DM reliability migration", () => {
  it.skipIf(!dockerAvailable())(
    "keeps commands ordered, starts rejection windows, and links activity",
    () => {
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      execFileSync("docker", [
        "run",
        "-d",
        "--name",
        container,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        image,
      ]);
      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (
            spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
              stdio: "ignore",
            }).status === 0
          )
            break;
          if (attempt === 39) throw new Error("Postgres did not accept connections.");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        }
        psql(`
        create role anon; create role authenticated; create role service_role;
        create table public.social_connections (
          id uuid primary key, provider text not null, provider_user_id text not null,
          unique (provider, provider_user_id)
        );
        create table public.instagram_dm_events (
          instagram_account_id text not null, connection_id uuid, status text,
          error_code text, created_at timestamptz default now()
        );
        create table public.facebook_dm_events (
          facebook_page_id text not null, connection_id uuid, status text,
          error_code text, created_at timestamptz default now()
        );
      `);
        psql(readFileSync("supabase/migrations/20261102091000_meta_auto_dm_safety.sql", "utf8"));
        psql(`
        insert into public.social_connections values
          ('11111111-1111-4111-8111-111111111111', 'instagram', 'ig-1'),
          ('22222222-2222-4222-8222-222222222222', 'facebook', 'fb-1');
        insert into public.instagram_dm_events (instagram_account_id, status, error_code)
          values ('ig-1', 'ignored', 'recipient_cooldown');
        insert into public.facebook_dm_events (facebook_page_id, status, error_code)
          values ('fb-1', 'ignored', 'account_budget');
      `);
        psql(
          readFileSync("supabase/migrations/20261103083000_meta_auto_dm_reliability.sql", "utf8"),
        );

        const hash = "12345678901234567890123456789012";
        const command = (id: string, at: string, stop: boolean) =>
          `select public.apply_meta_dm_recipient_command('instagram','ig-1','${hash}','${id}','${at}',${stop});`;
        expect(psql(command("stop-1", "2026-11-03T08:00:00Z", true))).toBe("applied");
        expect(psql(command("start-1", "2026-11-03T08:01:00Z", false))).toBe("applied");
        expect(psql(command("stop-1", "2026-11-03T08:00:00Z", true))).toBe("duplicate");
        expect(psql(command("stop-late", "2026-11-03T07:59:00Z", true))).toBe("stale");
        expect(
          psql(`select opted_out_at is null from public.meta_dm_recipient_preferences
        where provider='instagram' and provider_user_id='ig-1' and sender_id_hash='${hash}';`),
        ).toBe("t");
        expect(psql(command("stop-2", "2026-11-03T08:02:00Z", true))).toBe("applied");
        expect(
          psql(`select opted_out_at is not null from public.meta_dm_recipient_preferences
        where provider='instagram' and provider_user_id='ig-1' and sender_id_hash='${hash}';`),
        ).toBe("t");

        psql(
          "insert into public.meta_dm_account_guard (provider, provider_user_id) values ('instagram','ig-1');",
        );
        psql("select public.note_meta_dm_provider_rejection('instagram','ig-1','429');");
        expect(
          psql(
            "select rejection_count=1 and rejection_window_started_at is not null from public.meta_dm_account_guard where provider='instagram' and provider_user_id='ig-1';",
          ),
        ).toBe("t");
        psql(
          "select public.note_meta_dm_provider_rejection('instagram','ig-1','4'); select public.note_meta_dm_provider_rejection('instagram','ig-1','613');",
        );
        expect(
          psql(
            "select rejection_count=3 and paused_until>now() and pause_reason='provider_rate_limit' from public.meta_dm_account_guard where provider='instagram' and provider_user_id='ig-1';",
          ),
        ).toBe("t");

        expect(psql("select connection_id is not null from public.instagram_dm_events;")).toBe("t");
        expect(psql("select connection_id is not null from public.facebook_dm_events;")).toBe("t");
        psql(
          "insert into public.instagram_dm_events (instagram_account_id,status) values ('ig-1','processing'); insert into public.facebook_dm_events (facebook_page_id,status) values ('fb-1','processing');",
        );
        expect(
          psql("select bool_and(connection_id is not null) from public.instagram_dm_events;"),
        ).toBe("t");
        expect(
          psql("select bool_and(connection_id is not null) from public.facebook_dm_events;"),
        ).toBe("t");
      } finally {
        spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      }
    },
    30_000,
  );
});
