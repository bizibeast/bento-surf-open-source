import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const image = "postgres:16-alpine";
const container = `citation-dash-backfill-${process.pid}`;
const em = String.fromCodePoint(0x2014);

function dockerAvailable() {
  return (
    spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 &&
    spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0
  );
}

function psql(sql: string, tuplesOnly = false) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      ...(tuplesOnly ? ["-tA"] : []),
    ],
    { input: sql, encoding: "utf8" },
  );
}

describe("seo citation dash backfill", () => {
  it.skipIf(!dockerAvailable())(
    "matches normaliser edges and leaves null citations null",
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
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const ready = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
            stdio: "ignore",
          });
          if (ready.status === 0) break;
          if (attempt === 19) throw new Error("Postgres did not accept connections.");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        }
        psql(`
          create table public.seo_articles (
            id uuid primary key,
            slug text,
            citations jsonb
          );
          insert into public.seo_articles (id, slug, citations) values
            (
              '11111111-1111-4111-8111-111111111111',
              'youtube-video-transcript-generator',
              jsonb_build_array(jsonb_build_object(
                'title', chr(8212) || 'Hello' || chr(8212),
                'excerpt', 'a' || chr(8212) || chr(8212) || 'b ' || '10' || chr(8211) || '20' || chr(8211) || '30',
                'url', 'https://example.com/a' || chr(8212) || 'b'
              ))
            ),
            (
              '22222222-2222-4222-8222-222222222222',
              'youtube-video-transcript-generator',
              null
            ),
            (
              '33333333-3333-4333-8333-333333333333',
              'other-post',
              jsonb_build_array(jsonb_build_object('title', 'a' || chr(8212) || 'b'))
            );
        `);
        const script = readFileSync("scripts/backfill-seo-citation-dashes.sql", "utf8");
        expect(psql(script)).toContain("UPDATE 1");
        expect(psql(script)).toContain("UPDATE 0");
        expect(
          JSON.parse(
            psql(
              "select citations::text from public.seo_articles where id = '11111111-1111-4111-8111-111111111111';",
              true,
            ),
          ),
        ).toEqual([
          {
            url: `https://example.com/a${em}b`,
            title: "- Hello -",
            excerpt: "a - b 10-20-30",
          },
        ]);
        expect(
          psql(
            "select citations is null from public.seo_articles where id = '22222222-2222-4222-8222-222222222222';",
            true,
          ).trim(),
        ).toBe("t");
        expect(
          psql(
            "select citations::text from public.seo_articles where id = '33333333-3333-4333-8333-333333333333';",
            true,
          ),
        ).toContain(em);
      } finally {
        spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      }
    },
    30_000,
  );
});
