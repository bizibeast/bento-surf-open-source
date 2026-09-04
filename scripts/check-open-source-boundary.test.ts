import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkOpenSourceBoundary } from "./check-open-source-boundary";

const roots: string[] = [];
const run = promisify(execFile);
const guard = resolve("scripts/check-open-source-boundary.ts");

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe("open-source boundary", () => {
  test("reports excluded paths and production identity without printing file contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "bento-boundary-"));
    roots.push(root);
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(join(root, "src/safe.ts"), "export const ok = true;\n");
    await writeFile(join(root, "src/routes/features.index.tsx"), "export {};\n");
    const privateHost = ["https://app", "bento", "surf"].join(".");
    await writeFile(
      join(root, "src/config.ts"),
      `export const host = ${JSON.stringify(privateHost)};\n`,
    );

    expect(await checkOpenSourceBoundary(root)).toEqual([
      { file: "src/config.ts", reason: "private production identity" },
      { file: "src/routes/features.index.tsx", reason: "excluded marketing path" },
    ]);
  });

  test("reports populated configuration markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "bento-boundary-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    const token = ["abcdefghijkl", "mnopqrstuvwx"].join("");
    await writeFile(
      join(root, "src/config.ts"),
      [
        'const projectUrl = "https://project-ref.supabase.co";',
        'const owner = "Alex Doe";',
        `const originTrialToken = "${token}";`,
        'const EXAMPLE_API_SECRET = "not-a-placeholder";',
      ].join("\n"),
    );

    expect(await checkOpenSourceBoundary(root)).toEqual([
      { file: "src/config.ts", reason: "hard-coded Supabase project URL" },
      { file: "src/config.ts", reason: "non-empty example secret" },
      { file: "src/config.ts", reason: "personal identity marker" },
      { file: "src/config.ts", reason: "populated Origin Trial token" },
    ]);
  });

  test("does not confuse ordinary variables and test fixtures with boundary leaks", async () => {
    const root = await mkdtemp(join(tmpdir(), "bento-boundary-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, ".env.example"),
      [
        "WEBMCP_ORIGIN_TRIAL_TOKEN=",
        "WEBMCP_APP_ORIGIN_TRIAL_TOKEN=",
        "WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN=",
      ].join("\n"),
    );
    await writeFile(
      join(root, "src/config.ts"),
      [
        "const origin = configuredPublicOrigin(env.VITE_PUBLIC_URL);",
        "const originTrialToken = resolveWebMcpOriginTrialToken(env, request);",
        "const applyGlobalTokens = true;",
        'const secret = "test-secret";',
        'const appId = process.env.OTHER_APP_ID ?? "0123456789abcdef01234567";',
        'const featurebaseCsp = "https://do.featurebase.app https://*.featurebase.app wss://ws.featurebase.app";',
      ].join("\n"),
    );
    await writeFile(
      join(root, "src/config.test.ts"),
      [
        'const owner = "Alex Doe";',
        'const email = "hello@bento.surf";',
        'const portal = "workspace.featurebase.app";',
        'const featurebaseAppId = process.env.VITE_FEATUREBASE_APP_ID || "0123456789abcdef01234567";',
        'const originTrialToken = "abcdefghijklmnopqrstuvwx";',
      ].join("\n"),
    );

    expect(await checkOpenSourceBoundary(root)).toEqual([]);
  });

  test("checks tracked tests for secrets while limiting operated identity rules to runtime text", async () => {
    const root = await mkdtemp(join(tmpdir(), "bento-boundary-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "supabase"), { recursive: true });
    const projectRef = ["abcdefghij", "klmnopqrst"].join("");
    const credential = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const exampleSecret = ["re", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const operatedHost = ["mcp", ["ben", "to"].join(""), ["sur", "f"].join("")].join(".");
    const providerHost = ["workspace", "featurebase", "app"].join(".");
    const providerId = ["0123456789ab", "cdef01234567"].join("");

    await writeFile(
      join(root, "src/runtime.ts"),
      [
        `const endpoint = "${operatedHost}";`,
        `const portal = "${providerHost}";`,
        `const appId = process.env.VITE_FEATUREBASE_APP_ID || "${providerId}";`,
        'const EXPLORE_EXCLUDED_USERNAMES = new Set(["private-user"]);',
      ].join("\n"),
    );
    await writeFile(
      join(root, "src/generic.test.ts"),
      'const origin = "https://self.example"; const secret = "test-secret";\n',
    );
    await writeFile(join(root, "src/leak.test.ts"), `const leaked = "${credential}";\n`);
    await writeFile(join(root, "supabase/config.toml"), `project_id = "${projectRef}"\n`);
    await writeFile(join(root, ".env.example"), `RESEND_API_KEY=${exampleSecret}\n`);

    expect(await checkOpenSourceBoundary(root)).toEqual([
      { file: ".env.example", reason: "populated example secret" },
      { file: "src/leak.test.ts", reason: "credential-shaped secret" },
      { file: "src/runtime.ts", reason: "personal identity marker" },
      { file: "src/runtime.ts", reason: "private production identity" },
      { file: "src/runtime.ts", reason: "provider fallback identity" },
      { file: "supabase/config.toml", reason: "hard-coded Supabase project configuration" },
    ]);
  });

  test("uses tracked Git files and keeps CLI output value-safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "bento-boundary-"));
    roots.push(root);
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    const privateHost = ["https://app", "bento", "surf"].join(".");
    const untrackedSecret = "untracked-example-secret-value";
    const originTrialToken = ["abcdefghijklmnop", "qrstuvwxyz123456"].join("");
    await writeFile(join(root, ".github/workflows/put-release.yml"), "name: release\n");
    await writeFile(
      join(root, "src/config.ts"),
      `export const host = ${JSON.stringify(privateHost)};\n`,
    );
    await writeFile(join(root, ".env.example"), `WEBMCP_ORIGIN_TRIAL_TOKEN=${originTrialToken}\n`);
    await writeFile(
      join(root, "src/config.test.ts"),
      `const EXAMPLE_API_SECRET = ${JSON.stringify(untrackedSecret)};\n`,
    );
    await writeFile(join(root, ".env"), `EXAMPLE_API_SECRET=${untrackedSecret}\n`);
    await run("git", ["init", "--quiet"], { cwd: root });
    await run(
      "git",
      [
        "add",
        ".env.example",
        ".github/workflows/put-release.yml",
        "src/config.ts",
        "src/config.test.ts",
      ],
      { cwd: root },
    );

    expect(await checkOpenSourceBoundary(root)).toEqual([
      { file: ".env.example", reason: "populated Origin Trial token" },
      { file: ".github/workflows/put-release.yml", reason: "excluded marketing path" },
      { file: "src/config.ts", reason: "private production identity" },
    ]);

    let output = "";
    let errors = "";
    try {
      await run("bun", [guard], { cwd: root });
      throw new Error("boundary CLI should fail");
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      expect(result.code).toBe(1);
      output = result.stdout;
      errors = result.stderr;
    }

    expect(output).toBe(
      ".env.example: populated Origin Trial token\n.github/workflows/put-release.yml: excluded marketing path\nsrc/config.ts: private production identity\n",
    );
    expect(errors).toBe("");
    expect(`${output}${errors}`).not.toContain(privateHost);
    expect(`${output}${errors}`).not.toContain(untrackedSecret);
    expect(`${output}${errors}`).not.toContain(originTrialToken);
  });
});
